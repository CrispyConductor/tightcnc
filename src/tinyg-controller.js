const Controller = require('./controller');
const SerialPort = require('serialport');
const XError = require('xerror');
const pasync = require('pasync');
const gcodeParser = require('gcode-parser');

// Wrapper on top of gcode-parser to parse a line and return a map from word keys to values
function gparse(line) {
	let p = gcodeParser.parseLine(line);
	if (!p || !p.words || !p.words.length) return null;
	let r = {};
	for (let pair of p.words) {
		r[pair[0].toUpperCase()] = pair[1];
	}
	return r;
}

class TinyGController extends Controller {

	constructor(config = {}) {
		// Configuration for sending data that could potentially overflow the serial buffer to improve speed, but could impact responsiveness.
		// EXPERIMENTAL
		if (config.oversend === undefined) config.oversend = false; // whether to enable oversending
		if (config.oversendLimit === undefined) config.oversendLimit = 20; // max number to send without receiving responses over the standard threshold
		if (config.oversendPlannerMinAvailable === undefined) config.oversendPlannerMinAvailable = 12; // minimum number of spots to leave open in planner queue when oversending

		super(config);
		this.serial = null; // Instance of SerialPort stream interface class
		this.sendQueue = []; // Queue of data lines to send
		this.linesToSend = 0; // Number of lines we can currently reasonably send without filling the receive buffer
		this.responseWaiterQueue = []; // Queue of pasync waiters to be resolved when responses are received to lines; indexes match those of this.sendQueue
		this.responseWaiters = []; // pasync waiters for lines currently "in flight" (sent and waiting for response)
		this.axisLabels = [ 'x', 'y', 'z', 'a', 'b', 'c' ];

		this._waitingForSync = false;
		this.currentStatusReport = {};
		this.plannerQueueSize = 0; // Total size of planner queue
		this.plannerQueueFree = 0; // Number of buffers in the tinyg planner queue currently open
	}

	initConnection() {
		return new Promise((resolve, reject) => {
			// Set up options for serial connection.  (Set defaults, then apply configs on top.)
			let serialOptions = {
				autoOpen: true,
				baudRate: 115200,
				dataBits: 8,
				stopBits: 1,
				parity: 'none',
				rtscts: false,
				xany: true
			};
			for (let key in this.config) {
				if (key in serialOptions) {
					serialOptions[key] = this.config[key];
				}
			}
			let port = this.config.port || '/dev/ttyUSB0';

			// Callback for when open returns
			const serialOpenCallback = (err) => {
				if (err) {
					reject(new XError(XError.COMM_ERROR, 'Error opening serial port', err));
					return;
				}

				Promise.resolve()
					.then(() => {
						// Set up serial port communications handlers
						this._setupSerial();
					})
					.then(() => {
						// Setup the machine
						return this._initMachine();
					})
					.then(() => {
						// Set ready and resolve
						this.ready = true;
						this.emit('ready');
						this.emit('statusUpdate');
						resolve();
					})
					.catch((err) => {
						reject(err);
					});
			};

			// Open serial port, wait for callback
			this.serial = new SerialPort(port, serialOptions, serialOpenCallback);
		});
	}

	// Send as many lines as we can from the send queue
	_doSend() {
		if (this._waitingForSync) return; // don't send anything more until state has synchronized
		let curLinesToSend = this.linesToSend;
		if (this.config.oversend && this.plannerQueueSize) {
			let plannerNumToSend = this.plannerQueueFree - this.oversendPlannerMinAvailable;
			if (plannerNumToSend > curLinesToSend) {
				let curMaxOversend =  this.oversendLimit + curLinesToSend;
				if (plannerNumToSend > curMaxOversend) plannerNumToSend = curMaxOversend;
				if (plannerNumToSend > curLinesToSend) curLinesToSend = plannerNumToSend;
			}
		}
		while (curLinesToSend >= 1 && this.sendQueue.length >= 1) {
			this._sendImmediate(this.sendQueue.shift(), this.responseWaiterQueue.shift());
			curLinesToSend--;
		}
	}

	// Add a line to the send queue.  Return a promise that resolves when the response is received.
	sendWait(line) {
		let waiter = pasync.waiter();
		this.sendQueue.push(line);
		this.responseWaiterQueue.push(waiter);
		this._doSend();
		return waiter.promise;
	}

	// Immediately send a line to the device, bypassing the send queue
	_sendImmediate(line, responseWaiter = null) {
		if (typeof line !== 'string') line = JSON.stringify(line);
		line = line.trim();
		// Check if should decrement linesToSend (if not !, %, etc)
		if (line === '!' || line === '%' || line === '~' || line === '\x18') {
			this.serial.write(line);
			if (responseWaiter) responseWaiter.reject(new XError(XError.INVALID_ARGUMENT, 'Cannot wait for response on control character'));
		} else {
			// Check if this line will require any synchronization of state
			let stateSyncInfo = this._checkGCodeUpdateState(line);
			if (stateSyncInfo) {
				if (stateSyncInfo[1] && stateSyncInfo[1].length) {
					// There's additional gcode to send immediately after this
					let extraToSend = stateSyncInfo[1];
					this.sendQueue.unshift(...extraToSend);
				}
				if (stateSyncInfo[0]) {
					// There's a function to execute after the response is received
					if (!responseWaiter) responseWaiter = pasync.waiter();
					responseWaiter.promise.then(() => stateSyncInfo[0](), () => {});
				}
			}

			this.serial.write(line + '\n');
			this.linesToSend--;
			this.responseWaiters.push(responseWaiter);
		}
		this.emit('sent', line);
	}

	// Push a line onto the send queue to be sent when buffer space is available
	send(line) {
		this.sendQueue.push(line);
		this.responseWaiterQueue.push(null);
		this._doSend();
	}

	// Checks to see if the line of gcode should update stored state once executed.  This must be called in order
	// on all gcode sent to the device.  If the gcode line should update stored state, this returns a function that
	// should be called after the response is received for the gcode line.  It may also return (as the second element
	// of an array) a list of commands to send immediately after this gcode to ensure state is updated.
	_checkGCodeUpdateState(line) {
		let wordmap = gparse(line);
		if (!wordmap) return null;
		/* gcodes to watch for:
		 * G10 L2 - Changes coordinate system offsets
		 * G20/G21 - Select between inches and mm
		 * G28.1/G30.1 - Changes stored position
		 * G28.2 - Changes axis homed flags
		 * G28.3 - Also homes
		 * G54-G59 - Changes active coordinate system
		 * G90/G91 - Changes absolute/incremental
		 * G92* - Sets offset
		 * M2/M30 - In addition to ending program (handled by status reports), also changes others https://github.com/synthetos/TinyG/wiki/Gcode-Support#m2-m30-program-end
		 * M3/M4/M5 - Changes spindle state
		 * M7/M8/M9 - Changes coolant state
		*/
		let fn = null;
		let sendmore = [];

		let zeropoint = [];
		for (let i = 0; i < this.axisLabels.length; i++) zeropoint.push(0);

		if (wordmap.G === 10 && wordmap.L === 2 && wordmap.P) {
			fn = () => {
				let csys = wordmap.P - 1;
				if (!this.coordSysOffsets[csys]) this.coordSysOffsets[csys] = zeropoint;
				for (let axisNum = 0; axisNum < this.axisLabels.length; axisNum++) {
					let axis = this.axisLabels[axisNum].toUpperCase();
					if (axis in wordmap) this.coordSysOffsets[csys][axisNum] = wordmap[axis];
				}
				this.emit('statusUpdate');
			};
		}
		if (wordmap.G === 20 || wordmap.G === 21) {
			fn = () => {
				this.units = (wordmap.G === 20) ? 'in' : 'mm';
				this.emit('statusUpdate');
			};
		}
		if (wordmap.G === 28.1 || wordmap.G === 30.1) {
			fn = () => {
				let posnum = (wordmap.G === 28.1) ? 0 : 1;
				this.storedPositions[posnum] = this.mpos.slice();
				this.emit('statusUpdate');
			};
		}
		if (wordmap.G === 28.2 || wordmap.G === 28.3) {
			fn = () => {
				for (let axisNum = 0; axisNum < this.axisLabels.length; axisNum++) {
					let axis = this.axisLabels[axisNum].toUpperCase();
					if (axis in wordmap) this.homed[axisNum] = true;
				}
				this.emit('statusUpdate');
			};
		}
		if (wordmap.G >= 54 && wordmap.G <= 59 && Math.floor(wordmap.G) === wordmap.G) {
			fn = () => {
				this.activeCoordSys = wordmap.G - 54;
				this.emit('statusUpdate');
			};
		}
		if (wordmap.G === 90 || wordmap.G === 91) {
			fn = () => {
				this.incremental = !(wordmap.G === 90);
				this.emit('statusUpdate');
			};
		}
		if (wordmap.G === 92) {
			fn = () => {
				if (!this.offset) this.offset = zeropoint;
				for (let axisNum = 0; axisNum < this.axisLabels.length; axisNum++) {
					let axis = this.axisLabels[axisNum].toUpperCase();
					if (axis in wordmap) this.offset[axisNum] = wordmap[axis];
				}
				this.offsetEnabled = true;
				this.emit('statusUpdate');
			};
		}
		if (wordmap.G === 92.1) {
			fn = () => {
				this.offset = zeropoint;
				this.offsetEnabled = false;
				this.emit('statusUpdate');
			};
		}
		if (wordmap.G === 92.2) {
			fn = () => {
				this.offsetEnabled = false;
				this.emit('statusUpdate');
			};
		}
		if (wordmap.G === 92.3) {
			fn = () => {
				this.offsetEnabled = true;
				this.emit('statusUpdate');
			};
		}
		if (wordmap.M === 2 || wordmap.M === 30) {
			fn = () => {
				this.offset = zeropoint;
				this.offsetEnabled = false;
				this.activeCoordSys = 0;
				this.incremental = false;
				this.spindle = false;
				this.coolant = false;
				this.emit('statusUpdate');
			};
			sendmore.push({ coor: null }, { unit: null });
		}
		if (wordmap.M === 3 || wordmap.M === 4 || wordmap.M === 5) {
			fn = () => {
				this.spindle = (wordmap.M === 5) ? false : true;
				this.emit('statusUpdate');
			};
		}
		if (wordmap.M === 7 || wordmap.M === 8 || wordmap.M === 9) {
			fn = () => {
				if (wordmap.M === 7) this.coolant = 1;
				else if (wordmap.M === 8) this.coolant = 2;
				else this.coolant = false;
			};
		}

		if (!fn && !sendmore.length) return null;
		return [ fn, sendmore ];
	}

	async waitSync() {
		// Fetch new status report to ensure up-to-date info (mostly in case a move was just requested and we haven't gotten an update from that yet)
		await this.sendWait({ sr: null });
		// If the planner queue is empty, and we're not currently moving, then should be good
		if (!this.moving && this.plannerQueueFree === this.plannerQueueSize && !this.sendQueue.length && !this.responseWaiters.length) return Promise.resolve();
		// Otherwise, register a listener for status changes, and resolve when these conditions are met
		await new Promise((resolve, reject) => {
			if (this.error) return reject(new XError(XError.MACHINE_ERROR, 'Machine error code: ' + this.errorData));
			let removeListeners;
			this._waitingForSync = true;
			const statusHandler = () => {
				if (this.error) {
					this._waitingForSync = false;
					removeListeners();
					reject(new XError(XError.MACHINE_ERROR, 'Machine error code: ' + this.errorData));
				} else if (!this.moving && this.plannerQueueFree === this.plannerQueueSize && !this.sendQueue.length && !this.responseWaiters.length) {
					this._waitingForSync = false;
					removeListeners();
					resolve();
					this._doSend();
				}
			};
			const cancelRunningOpsHandler = (err) => {
				this._waitingForSync = false;
				removeListeners();
				reject(err);
			};
			removeListeners = () => {
				this.removeListener('statusUpdate', statusHandler);
				this.removeListener('sent', statusHandler);
				this.removeListener('afterReceived', statusHandler);
				this.removeListener('cancelRunningOps', cancelRunningOpsHandler);
			};
			this.on('statusUpdate', statusHandler); // main listener we're interested in
			this.on('sent', statusHandler); // these two are for edge cases (things that change sendQueue or responseWaiters without statusUpdate)
			this.on('afterReceived', statusHandler);
			this.on('cancelRunningOps', cancelRunningOpsHandler);
		});
	}

	_handleReceiveSerialDataLine(line) {
		this.emit('received', line);
		if (line[0] != '{') throw new XError(XError.PARSE_ERROR, 'Errror parsing received serial line', { data: line });
		let data = JSON.parse(line);

		// Check if this is a SYSTEM READY response indicating a reset
		if ('r' in data && data.r.msg === 'SYSTEM READY') {
			this._cancelRunningOps(new XError(XError.CANCELLED, 'Machine reset'));
			this.ready = false;
			this._resetSerialState();
			this._initMachine()
				.then(() => {
					this.ready = true;
					this.emit('ready');
					this.emit('statusUpdate');
				})
				.catch((err) => this.emit('error', err));
			return;
		}

		// Check if this is an error report indicating an alarm state
		if ('er' in data) {
			this.error = true;
			this.errorData = data.er;
			this.ready = false;
			let err = new XError(XError.MACHINE_ERROR, data.er.msg || ('Code ' + data.er.st) || 'Machine error report', data.er);
			this._cancelRunningOps(err);
			this.emit('error', err);
			return;
		}

		let statusVars = {}; // updated status vars
		if ('sr' in data) {
			// Update the current status variables
			for (let key in data.sr) statusVars[key] = data.sr[key];
		}
		if ('qr' in data) {
			// Update queue report
			statusVars.qr = data.qr;
		}
		for (let key in this.currentStatusReport) {
			if (key in data) statusVars[key] = data[key];
			if ('r' in data && key in data['r']) statusVars[key] = data['r'][key];
		}
		if ('r' in data) {
			if ('sr' in data.r) {
				// Update the current status variables
				for (let key in data.r.sr) statusVars[key] = data.r.sr[key];
			}
			if ('n' in data.r) {
				// Update gcode line number
				statusVars.n = data.r.n;
			}
			if ('qr' in data.r) {
				// Update queue number
				statusVars.qr = data.r.qr;
			}
			// Update status properties
			this._updateStatusReport(statusVars);
			// Check if successful or failure response
			let statusCode = data.f ? data.f[1] : 0;
			// Update the send buffer stats and try to send more data
			this.linesToSend++;
			let responseWaiter = this.responseWaiters.shift();
			if (responseWaiter) {
				// status codes: https://github.com/synthetos/TinyG/wiki/TinyG-Status-Codes
				if (statusCode === 0) {
					responseWaiter.resolve(data);
				} else {
					responseWaiter.reject(new XError(XError.MACHINE_ERROR, 'TinyG error status code: ' + statusCode));
				}
			}
			this._doSend();
		} else {
			this._updateStatusReport(statusVars);
		}
		this.emit('afterReceived', line);
	}

	// Update stored state information with the given status report information
	_updateStatusReport(sr, emitEvent = true) {
		// Update this.currentStatusReport
		let statusUpdated = false;
		for (let key in sr) {
			if (this.currentStatusReport[key] !== sr[key]) {
				this.currentStatusReport[key] = sr[key];
				statusUpdated = true;
			}
		}
		// Keys we care about: mpo{x}, coor, g5{4}{x}, g92{x}, g{28,30}{x}, hom{x}, stat, unit, feed, dist, n
		// Check for axis-specific keys
		for (let axisNum = 0; axisNum < this.axisLabels.length; axisNum++) {
			let axis = this.axisLabels[axisNum];
			if (('mpo' + axis) in sr) this.mpos[axisNum] = sr['mpo' + axis];
			if (('g92' + axis) in sr) this.offset[axisNum] = sr['g92' + axis];
			if (('g28' + axis) in sr) this.storedPositions[0][axisNum] = sr['g28' + axis];
			if (('g30' + axis) in sr) this.storedPositions[1][axisNum] = sr['g30' + axis];
			if (('hom' + axis) in sr) this.homed[axisNum] = !!sr['hom' + axis];
			for (let csys = 0; csys < 6; csys++) {
				let csysName = 'g5' + (4 + csys);
				if (!this.coordSysOffsets[csys]) this.coordSysOffsets[csys] = [];
				if ((csysName + axis) in sr) this.coordSysOffsets[csys][axisNum] = sr[csysName + axis];
			}
		}
		// Non-axis keys
		if ('coor' in sr) {
			this.activeCoordSys = (sr.coor === 0) ? null : sr.coor - 1;
		}
		if ('unit' in sr) {
			this.units = sr.unit ? 'mm' : 'in';
		}
		if ('feed' in sr) {
			this.feed = sr.feed;
		}
		if ('dist' in sr) {
			this.incremental = !!sr.dist;
		}
		if ('n' in sr) {
			this.line = sr.n;
		}
		if ('qr' in sr) {
			this.plannerQueueFree = sr.qr;
		}
		if ('stat' in sr) {
			switch(sr.stat) {
				case 0: // initializing
					this.ready = false;
					this.paused = false;
					this.moving = false;
					this.error = false;
					this.programRunning = false;
					break;
				case 1: // "reset"
					this.ready = true;
					this.paused = false;
					this.moving = false;
					this.error = false;
					this.programRunning = false;
					break;
				case 2: // alarm
					this.ready = false;
					this.paused = false;
					this.moving = false;
					this.error = true;
					if (!this.errorData) this.errorData = 'alarm';
					break;
				case 3: // stop
				case 8: // cycle
					this.ready = true;
					this.paused = false;
					this.moving = false;
					this.error = false;
					this.programRunning = true;
					break;
				case 4: // end
					this.ready = true;
					this.paused = false;
					this.moving = false;
					this.error = false;
					this.programRunning = false;
					break;
				case 5: // run
					this.ready = true;
					this.paused = false;
					this.moving = true;
					this.error = false;
					this.programRunning = true;
					break;
				case 6: // hold
					this.ready = true;
					this.paused = true;
					this.moving = false;
					this.error = false;
					break;
				case 7: // probe
					this.ready = true;
					this.paused = false;
					this.moving = true;
					this.error = false;
					break;
				case 9: // homing
					this.ready = true;
					this.paused = false;
					this.moving = true;
					this.error = false;
					break;
				default:
					throw new XError(XError.INTERNAL_ERROR, 'Unknown machine state: ' + sr.stat);
			}
		}
		if (statusUpdated && emitEvent) {
			this.emit('statusUpdate');
		}
	}

	// Fetch and update current status from machine, if vars is null, update all
	_fetchStatus(vars = null, emitEvent = true) {
		if (!vars) {
			vars = [ 'coor', 'stat', 'unit', 'feed', 'dist', 'n', 'qr' ];
			for (let axisNum = 0; axisNum < this.axisLabels.length; axisNum++) {
				let axis = this.axisLabels[axisNum];
				vars.push('mpo' + axis, 'g92' + axis, 'g28' + axis, 'g30' + axis, 'hom' + axis);
				for (let csys = 0; csys < 6; csys++) {
					vars.push('g5' + (4 + csys) + axis);
				}
			}
		}

		// Fetch each, constructing a status report
		let sr = {};
		let promises = [];
		const fetchVar = (name) => {
			let p = this.sendWait({ [name]: null })
				.then((data) => {
					sr[name] = data.r[name];
				});
			promises.push(p);
		};
		for (let name of vars) {
			fetchVar(name);
		}
		return Promise.all(promises)
			.then(() => {
				this._updateStatusReport(sr, emitEvent);
			});
	}

	// Send serial commands to initialize machine and state after new serial connection
	async _initMachine() {
		// Strict json syntax.  Needed to parse with normal JSON parser.  Change this if abbreviated json parser is implemented.
		await this.sendWait({ js: 1 });
		// Echo off (ideally this would be set at the same time as the above)
		await this.sendWait({ ee: 0 });
		// Set json output verbosity
		await this.sendWait({ jv: 4 });
		// Enable (filtered) automatic status reports
		await this.sendWait({ sv: 1});
		// Enable queue reports
		await this.sendWait({ qv: 1 });
		// Set automatic status report interval
		await this.sendWait({ si: this.config.statusReportInterval || 250 });
		// Configure status report fields
		//await this.sendWait({ sr: false }); // to work with future firmware versions where status report variables are configured incrementally
		let srVars = [ 'n', 'feed', 'stat' ];
		for (let axis of this.axisLabels) { srVars.push('mpo' + axis); }
		let srConfig = {};
		for (let name of srVars) { srConfig[name] = true; }
		await this.sendWait({ sr: srConfig });
		// Fetch initial state
		await this._fetchStatus(null, false);
		// Set the planner queue size to the number of free entries (it's currently empty)
		this.plannerQueueSize = this.plannerQueueFree;
	}

	_resetSerialState() {
		this.sendQueue = [];
		this.responseWaiterQueue = [];
		this.responseWaiters = [];
		this.linesToSend = 4;
		this._waitingForSync = false;
	}

	_setupSerial() {
		const handlePortClosed = () => {
			this.ready = false;
			const tryReopen = () => {
				setTimeout(() => {
					this.initConnection()
						.catch(() => {
							tryReopen();
						});
				}, 1000);
			};
			tryReopen();
		};

		this.serial.on('error', (err) => {
			this.emit('error', new XError(XError.COMM_ERROR, 'Serial port error', err));
			handlePortClosed();
		});

		this.serial.on('close', () => {
			handlePortClosed();
		});

		this.serialReceiveBuf = '';
		this.currentStatusReport = {};
		this._resetSerialState();

		this.serial.on('data', (buf) => {
			let str = this.serialReceiveBuf + buf.toString('utf8');
			let strlines = str.split(/[\r\n]+/);
			if (!strlines[strlines.length-1].trim()) {
				// Received data ended in a newline, so don't need to buffer anything
				strlines.pop();
				this.serialReceiveBuf = '';
			} else {
				// Last line did not end in a newline, so add to buffer
				this.serialReceiveBuf = strlines.pop();
			}
			// Process each received line
			for (let line of strlines) {
				line = line.trim();
				if (line) {
					try {
						this._handleReceiveSerialDataLine(line);
					} catch (err) {
						this.emit('error', err);
					}
				}
			}
		});
	}

	sendStream(stream) {
		let waiter = pasync.waiter();

		let dataBuf = '';
		// Bounds within which to stop and start reading from the stream
		let sendQueueHighWater = this.config.streamSendQueueHighWaterMark || 50;
		let sendQueueLowWater = this.config.streamSendQueueLowWaterMark || 10;
		let streamPaused = false;
		let canceled = false;

		const sendLines = (lines) => {
			for (let line of lines) {
				line = line.trim();
				if (line) this.send(line);
			}
		};

		const sentListener = () => {
			// Check if paused stream can be resumed
			if (streamPaused && this.sendQueue.length <= sendQueueLowWater) {
				stream.resume();
				streamPaused = false;
			}
		};

		const cancelHandler = (err) => {
			this.removeListener('sent', sentListener);
			this.removeListener('cancelRunningOps', cancelHandler);
			canceled = true;
			stream.emit('error', err);
		};

		this.on('sent', sentListener);

		stream.on('data', (chunk) => {
			if (canceled) return;
			if (typeof chunk !== 'string') chunk = chunk.toString('utf8');
			dataBuf += chunk;
			let lines = dataBuf.split(/\r?\n/);
			if (lines[lines.length - 1] !== '') {
				// does not end in newline, so the last component goes back in the buf
				dataBuf = lines.pop();
			} else {
				lines.pop();
				dataBuf = '';
			}
			sendLines(lines);
			// if send queue is too full, pause the stream
			if (this.sendQueue.length >= sendQueueHighWater) {
				stream.pause();
				streamPaused = true;
			}
		});

		stream.on('end', () => {
			if (canceled) return;
			sendLines(dataBuf.split(/\r?\m/));
			this.removeListener('sent', sentListener);
			this.removeListener('cancelRunningOps', cancelHandler);
			this.waitSync()
				.then(() => waiter.resolve(), (err) => waiter.reject(err));
		});

		this.on('cancelRunningOps', cancelHandler);

		return waiter.promise;
	}

	_cancelRunningOps(err) {
		for (let p of this.responseWaiterQueue) if (p) p.reject(err);
		for (let p of this.responseWaiters) if (p) p.reject(err);
		this.emit('cancelRunningOps', err);
		this.sendQueue = [];
		this.responseWaiterQueue = [];
		this.responseWaiters = [];
	}

	hold() {
		this._sendImmediate('!');
		this.paused = true;
	}

	resume() {
		this._sendImmediate('~');
		this.paused = false;
	}

	cancel() {
		if (!this.paused) this.hold();
		this._cancelRunningOps(new XError(XError.CANCELLED, 'Operation cancelled'));
		this._sendImmediate('%');
		this.paused = false;
		this._resetSerialState();
	}

	reset() {
		this._cancelRunningOps(new XError(XError.CANCELLED, 'Machine reset'));
		this._sendImmediate('\x18');
		this.ready = false; // will be set back to true once SYSTEM READY message received
	}

};

module.exports = TinyGController;



