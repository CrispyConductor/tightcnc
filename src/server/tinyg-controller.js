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
		this.usedAxes = config.usedAxes || [ true, true, true, false, false, false ];
		this.homableAxes = config.homableAxes || [ true, true, true ];
		this.axisMaxFeeds = [ 500, 500, 500, 500, 500, 500 ]; // initial values, set later during initialization

		this._waitingForSync = false; // disable sending additional commands while waiting for synchronization
		this._disableSending = false; // flag to disable sending data using normal channels (_sendImmediate still works)
		this._disableResponseErrorEvent = false; // flag to disable error events in cases where errors are expected
		this.currentStatusReport = {};
		this.plannerQueueSize = 0; // Total size of planner queue
		this.plannerQueueFree = 0; // Number of buffers in the tinyg planner queue currently open

		this.realTimeMovesTimeStart = [ 0, 0, 0, 0, 0, 0 ];
		this.realTimeMovesCounter = [ 0, 0, 0, 0, 0, 0 ];

		this._serialListeners = {}; // mapping from serial port event names to listener functions; used to remove listeners during cleanup
	}

	initConnection(retry = true) {
		if (this._initializing) return;
		this._retryConnectFlag = retry;
		this.ready = false;
		this._initializing = true;
		this.emit('statusUpdate');

		// Define an async function and call it so we can use async/await
		const doInit = async () => {

			// Set up options for serial connection.  (Set defaults, then apply configs on top.)
			let serialOptions = {
				autoOpen: true,
				baudRate: 115200,
				dataBits: 8,
				stopBits: 1,
				parity: 'none',
				rtscts: false,
				xon: true,
				xoff: true
			};
			for (let key in this.config) {
				if (key in serialOptions) {
					serialOptions[key] = this.config[key];
				}
			}
			let port = this.config.port || '/dev/ttyUSB0';

			// Try to open the serial port
			await new Promise((resolve, reject) => {
				this.serial = new SerialPort(port, serialOptions, (err) => {
					if (err) reject(new XError(XError.COMM_ERROR, 'Error opening serial port', err));
					else resolve();
				});
			});

			// Initialize serial buffers and initial variables
			this.serialReceiveBuf = '';
			this.currentStatusReport = {};
			this._resetSerialState();

			// Set up serial port communications handlers
			const onSerialError = (err) => {
				err = new XError(XError.COMM_ERROR, 'Serial port communication error', err);
				if (!this._initializing) this.emit('error', err); // don't emit during initialization 'cause that's handled separately (by rejecting the waiters during close())
				this.close(err);
				this._retryConnect();
			};
			const onSerialClose = () => {
				// Note that this isn't called during intended closures via this.close(), since this.close() first removes all handlers
				let err = new XError(XError.COMM_ERROR, 'Serial port closed unexpectedly');
				if (!this._initializing) this.emit('error', err);
				this.close(err);
				this._retryConnect();
			};
			const onSerialData = (buf) => {
				// Remove any stray XONs, XOFFs, and NULs from the stream
				let newBuf = Buffer.alloc(buf.length);
				let newBufIdx = 0;
				for (let b of buf) {
					if (b != 0 && b != 17 && b != 19) {
						newBuf[newBufIdx] = b;
						newBufIdx++;
					}
				}
				buf = newBuf.slice(0, newBufIdx);

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
							if (!this._initializing) this.emit('error', err);
							this.close(err);
							this._retryConnect();
							break;
						}
					}
				}
			};
			this._serialListeners = {
				error: onSerialError,
				close: onSerialClose,
				data: onSerialData
			};
			for (let eventName in this._serialListeners) this.serial.on(eventName, this._serialListeners[eventName]);

			// Initialize all the machine state properties
			await this._initMachine();

			// Initialization succeeded
			this.ready = true;
			this._initializing = false;
			this.emit('ready');
			this.emit('statusUpdate');

		};

		doInit()
			.catch((err) => {
				this.emit('error', new XError(XError.COMM_ERROR, 'Error initializing connection', err));
				this.close(err);
				this._initializing = false;
				this._retryConnect();
			});
	}

	close(err) {
		if (err && !this.error) {
			this.error = true;
			this.errorData = err;
		}
		this.ready = false;
		this._cancelRunningOps(err || new XError(XError.CANCELLED, 'Operations cancelled due to close'));
		if (this.serial) {
			for (let key in this._serialListeners) {
				this.serial.removeListener(key, this._serialListeners[key]);
			}
			this._serialListeners = [];
			this.serial.on('error', () => {}); // swallow errors on this port that we're discarding
			try { this.serial.close(); } catch (err2) {}
			delete this.serial;
		}
		this.emit('statusUpdate');
	}

	_retryConnect() {
		if (!this._retryConnectFlag) return;
		setTimeout(() => this.initConnection(true), 5000);
	}

	_numInFlightRequests() {
		return this.responseWaiters.length;
	}

	// Send as many lines as we can from the send queue
	_doSend() {
		if (this._waitingForSync || this._disableSending) return; // don't send anything more until state has synchronized
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
		if (!this.serial) throw new XError(XError.COMM_ERROR, 'Not connected');
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
		if (!this.serial) throw new XError(XError.COMM_ERROR, 'Not connected');
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
		if (wordmap.G === 93 || wordmap.G === 94) {
			fn = () => {
				this.inverseFeed = wordmap.G === 93;
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
				this.spindleDirection = (wordmap.M === 4) ? -1 : 1;
				this.spindleSpeed = wordmap.S || null;
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
		// If sends are disabled, instead just wait some time to make sure a response was received
		if (this._disableSending) {
			await pasync.setTimeout(250);
		} else {
			await this.sendWait({ sr: null });
		}
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
			let err = new XError(XError.CANCELLED, 'Machine reset');
			this.close(err);
			this._retryConnect();
			return;
		}

		// Check if this is an error report indicating an alarm state
		if ('er' in data) {
			if (!this._disableResponseErrorEvent) {
				this.error = true;
				this.errorData = data.er;
				this.ready = false;
				let err = new XError(XError.MACHINE_ERROR, data.er.msg || ('Code ' + data.er.st) || 'Machine error report', data.er);
				this._cancelRunningOps(err);
				if (!this._initializing) this.emit('error', err);
			}
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
			// If there are no response waiter entries (including nulls), it means a response was received without an associated request.
			// This seems to occur during probing on my current firmware version (see comment in probe()).  Ignore such responses.
			if (this.responseWaiters.length) {
				// Update lines to send counter
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
			}
			// Try to send more data
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
		// Fetch axis maximum velocities
		for (let axisNum = 0; axisNum < this.usedAxes.length; axisNum++) {
			if (this.usedAxes[axisNum]) {
				let axis = this.axisLabels[axisNum];
				let response = await this.sendWait({ [axis + 'vm']: null });
				if (typeof response[axis + 'vm'] === 'number') {
					this.axisMaxFeeds[axisNum] = response[axis + 'vm'];
				}
			}
		}
	}

	_resetSerialState() {
		this.sendQueue = [];
		this.responseWaiterQueue = [];
		this.responseWaiters = [];
		this.linesToSend = 6; // note: tinyg docs recommend 4, with a max of 8; 6 is used here for slightly better performance with lots of short moves
		this._waitingForSync = false;
		this._disableSending = false;
	}

	sendStream(stream) {
		let waiter = pasync.waiter();

		let dataBuf = '';
		// Bounds within which to stop and start reading from the stream
		let sendQueueHighWater = this.config.streamSendQueueHighWaterMark || 5;
		let sendQueueLowWater = this.config.streamSendQueueLowWaterMark || Math.min(10, Math.floor(sendQueueHighWater / 5));
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
			waiter.reject(err);
			stream.emit('error', err);
		};

		stream.on('error', (err) => {
			if (canceled) return;
			this.removeListener('sent', sentListener);
			this.removeListener('cancelRunningOps', cancelHandler);
			waiter.reject(err);
			canceled = true;
		});

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

	async home(axes = null) {
		if (!axes) axes = this.homableAxes;
		let gcode = 'G28.2';
		for (let axisNum = 0; axisNum < axes.length; axisNum++) {
			if (axes[axisNum]) {
				gcode += ' ' + this.axisLabels[axisNum].toUpperCase() + '0';
			}
		}
		await this.sendWait(gcode);
		await this.waitSync();
	}

	async move(pos, feed = null) {
		let gcode = feed ? 'G1' : 'G0';
		for (let axisNum = 0; axisNum < pos.length; axisNum++) {
			if (typeof pos[axisNum] === 'number') {
				gcode += ' ' + this.axisLabels[axisNum].toUpperCase() + pos[axisNum];
			}
		}
		await this.sendWait(gcode);
		await this.waitSync();
	}

	realTimeMove(axisNum, inc) {
		// Make sure there aren't too many requests in the queue
		if (this._numInFlightRequests() > (this.config.realTimeMovesMaxQueued || 8)) return false;
		// Rate-limit real time move requests according to feed rate
		let rtmTargetFeed = (this.axisMaxFeeds[axisNum] || 500) * 0.9; // target about 90% of max feed rate
		let counterDecrement = (new Date().getTime() - this.realTimeMovesTimeStart[axisNum]) / 1000 * rtmTargetFeed / 60;
		this.realTimeMovesCounter[axisNum] -= counterDecrement;
		if (this.realTimeMovesCounter[axisNum] < 0) {
			this.realTimeMovesCounter[axisNum] = 0;
		}
		this.realTimeMovesTimeStart[axisNum] = new Date().getTime();
		let maxOvershoot = (this.config.realTimeMovesMaxOvershootFactor || 2) * Math.abs(inc);
		if (this.realTimeMovesCounter[axisNum] > maxOvershoot) return false;
		this.realTimeMovesCounter[axisNum] += Math.abs(inc);
		// Send the move
		this.send('G91');
		let gcode = 'G0 ' + this.axisLabels[axisNum].toUpperCase() + inc;
		this.send(gcode);
		this.send('G90');
	}

	async probe(pos, feed = null) {
		/*
		 * My TinyG {fb:440.20, fv:0.97} has probing behavior that does not match the documented
		 * behavior (12/1/19) in several ways.  This code should work with both my TinyG, and the behavior
		 * as documented.  The oddities are:
		 * - The documentation implies that automatic probe reports are generated outside of a
		 *   response wrapper.  Ie, automatic probe reports should come back as {"prb":{...}}.
		 *   Instead, they are wrapped in a response wrapper as {"r":{"prb":{...}}.  This is
		 *   inconsistent with the communications protocol documentation which states that exactly
		 *   one {"r":{...}} response is returned for each sent request, and causes their provided
		 *   communications algorithm to become desynced (since the probe report with response
		 *   wrapper is generated without an accompanying request).  This is handled by 1) Ignoring
		 *   any responses that occur when there are no in-flight requests, 2) Ensure there are no
		 *   other in-flight requests before probing, 3) Disabling data sends while probing is in
		 *   progress, 4) Ignoring any automatic probe reports and instead manually requesting them.
		 *   5) Waiting a small period of time after probing completes to allow this extra response
		 *   to be received and ignored, before sending any more data.
		 * - The documentation states that automatic probe reports can be disabled with {prbr:f}.
		 *   This has no effect for me, and automatic probe reports continue to be generated.  Hence
		 *   the above workarounds.
		 * - The documentation states that G38.3 should be used for probing without alarming on no
		 *   contact.  G38.3 does nothing for me.  Instead, G38.2 is used here.
		 * - The documentation states that G38.2 will put the machine in soft alarm state if the
		 *   probe is not tripped.  This does not occur for me.  To handle systems where it may,
		 *   {clear:null} is sent unconditionally after probing completes.  Additionally, if waitForSync
		 *   rejects, the rejection is ignored.
		 * - On my TinyG, G38.2 seems to do nothing in some cases where more than one axis is provided.
		 *   So this function ensures that at most one axis differs from the current position, and only
		 *   sends that.
		 * - The LinuxCNC documentation (referenced by the TinyG documentation) states that the
		 *   coordinates of the parameters should be in the current coordinate system (and, presumably,
		 *   should match the coordinates of the probe reports).  With my TinyG, both the parameters
		 *   and coordinates are in machine coordinates.  Because this probably won't be reliably
		 *   consistent, a test is performed for the first probe.  A G38.2 probe is sent for the current
		 *   position (either in machine coords or local coords, whichever will cause the probe to
		 *   move in the right direction if we're wrong).  If any motion is detected, the move is immediately
		 *   cancelled, and we know it's the other coordinate system.  If there's no motion, we
		 *   know it's that coordinate system.  This test can be overridden using config.probeUsesMachineCoords.
		 * - Requests for status reports during probing don't seem to work (they seem to be delayed until
		 *   after probing is complete).  So we can't rely on this to know when probe movement has started.
		 *   Instead, just wait for a delay after sending the probe before checking for movement status.
		 *   This is handled by waitSync().
		 * - On my TinyG, its active coordinate system is randomly reset after probing.  Handle this by saving
		 *   the active coordinate system prior to probing, and manually restoring it after.
		 * - I've occasionally seen cases where the 'e' return value in the probe report does not reliably
		 *   report when the probe it tripped (it's set to 0 even if the probe was in fact tripped).  To
		 *   compensate for this, also consider the probe tripped if it terminated before reaching its
		 *   endpoint.
		 */

		let waiter;
		if (feed === null || feed === undefined) feed = 25;

		// Disable other requests while probing is running
		this._disableSending = true;
		// Disable error events, since we may need to handle soft alarms
		this._disableResponseErrorEvent = true;

		try {
			// Wait for motion to stop so position information is synchronized
			await this.waitSync();

			// Ensure a single axis will move.
			let selectedAxisNum = null;
			let curOffsets = this.getCoordOffsets();
			let curPos = this.getPos().slice();
			for (let axisNum = 0; axisNum < pos.length; axisNum++) {
				if (typeof pos[axisNum] === 'number' && pos[axisNum] !== curPos[axisNum]) {
					if (selectedAxisNum !== null) {
						throw new XError(XError.INVALID_ARGUMENT, 'Can only probe on a single axis at once');
					}
					selectedAxisNum = axisNum;
				}
			}
			if (selectedAxisNum === null) throw new XError(XError.INVALID_ARGUMENT, 'Cannot probe to same location');

			// Store the currently active coordinate system to work around tinyg bug
			let activeCoordSys = this.activeCoordSys;

			// Test if the current version of TinyG uses machine coordinates for probing or local coordinates
			// Note that if offsets are zero, it doesn't matter, and don't bother testing
			// If, at some point, the build versions of TinyG that have this oddity are known and published, those will be a much better test than this hack
			if (this.config.probeUsesMachineCoords === undefined && curOffsets[selectedAxisNum] !== 0) {
				// See above block comment for explanation of this process.
				// determine if test probe is to same coordinates in offset coords or machine coords
				let probeTestToSameMachineCoords = curOffsets[selectedAxisNum] > 0;
				if (pos[selectedAxisNum] - curPos[selectedAxisNum] < 0) probeTestToSameMachineCoords = !probeTestToSameMachineCoords;
				let probeTestCoord = probeTestToSameMachineCoords ? this.mpos[selectedAxisNum] : curPos[selectedAxisNum];
				let startingMCoord = this.mpos[selectedAxisNum];
				// run probe to selected point; use _sendImmediate since normal sends are disabled
				const probeTestFeed = 1;
				let testProbeGcode = 'G38.2 ' + this.axisLabels[selectedAxisNum].toUpperCase() + probeTestCoord + ' F' + probeTestFeed;
				waiter = pasync.waiter();
				this._sendImmediate(testProbeGcode, waiter);
				// Probing to the same point is not currently a response error on my system, but in case it becomes one, wrap this in a try/catch
				try { await waiter.promise; } catch (err) {}
				// On my system, probing to the same point generates an extra response (after the normal response) that looks like this: {"r":{"msg":"Probing error - invalid probe destination"},"f":[1,250,0,8644]}
				// To allow time for this response to be received, as well as for movement to start (at this slow feed rate), wait a short period of time
				await pasync.setTimeout(750);
				// Execute a feed hold (to stop movement if it's occurring), a wipe (to prevent the movement from resuming), and a clear (in case it soft alarmed)
				this._sendImmediate('!');
				this._sendImmediate('%');
				this._sendImmediate({clear:null});
				// Reject the waiter if it hasn't resolved, since we cleared it out with the wipe
				waiter.reject('');
				// Request an updated machine position for the axis we're testing
				waiter = pasync.waiter();
				this._sendImmediate({ ['mpo' + this.axisLabels[selectedAxisNum].toLowerCase()]: null }, waiter);
				let mpoResult = await waiter.promise;
				// Depending on whether or not the probe moved during that time, we now know if this tinyg version expects machine or offset coordinates
				let nowMCoord = mpoResult.r['mpo' + this.axisLabels[selectedAxisNum].toLowerCase()];
				if (typeof nowMCoord !== 'number') throw new XError(XError.INTERNAL_ERROR, 'Unexpected response from TinyG');
				let probeMoved = nowMCoord !== startingMCoord;
				if (probeMoved) {
					this.config.probeUsesMachineCoords = !probeTestToSameMachineCoords;
					// Move back to the starting position before the test
					waiter = pasync.waiter();
					this._sendImmediate('G53 G0 ' + this.axisLabels[selectedAxisNum].toUpperCase() + startingMCoord, waiter);
					await waiter.promise;
				} else {
					this.config.probeUsesMachineCoords = probeTestToSameMachineCoords;
				}
			}
			let useMachineCoords = curOffsets[selectedAxisNum] === 0 || this.config.probeUsesMachineCoords;

			// Run the probe in the coordinate system chosen
			let probeTo = useMachineCoords ? (pos[selectedAxisNum] + curOffsets[selectedAxisNum]) : pos[selectedAxisNum];
			let probeDirection = (pos[selectedAxisNum] > curPos[selectedAxisNum]) ? 1 : -1;
			let probeGcode = 'G38.2 ' + this.axisLabels[selectedAxisNum].toUpperCase() + probeTo + ' F' + feed;
			waiter = pasync.waiter();
			this._sendImmediate(probeGcode, waiter);
			await waiter.promise; // wait for first response to probe to be received
			await this.waitSync(); // wait for probe movement to stop
			await pasync.setTimeout(250); // wait additional time to ensure "extra" response is received and ignored
			this._sendImmediate({clear:null}); // clear possible soft alarm state

			// Fetch probe report
			waiter = pasync.waiter();
			this._sendImmediate({ prb: null }, waiter);
			let probeResult = await waiter.promise;
			let probeReport = probeResult.r.prb;
			let probeTripped = !!probeReport.e;
			let probePos = probeReport[this.axisLabels[selectedAxisNum]];

			// Workaround for e value sometimes being incorrect
			if (
				(probeDirection > 0 && probePos < probeTo) ||
				(probeDirection < 0 && probePos > probeTo)
			) {
				probeTripped = true;
			}

			// Restore active coordinate system (to work around bug)
			if (typeof activeCoordSys === 'number' && activeCoordSys >= 0) {
				this._sendImmediate('G' + (54 + activeCoordSys));
				this.activeCoordSys = activeCoordSys;
			}

			// Handle probe results
			if (!probeTripped) {
				throw new XError(XError.PROBE_NOT_TRIPPED, 'Probe was not tripped during probing');
			}
			if (useMachineCoords) {
				// Convert probe report position from machine coords back to offset coords
				probePos = probePos - curOffsets[selectedAxisNum];
			}
			curPos[selectedAxisNum] = probePos;
			return curPos;

		} finally {
			this._disableSending = false;
			this._disableResponseErrorEvent = false;
			this._doSend();
		}
	}

};

module.exports = TinyGController;



