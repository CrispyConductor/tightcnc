const Controller = require('./controller');
const SerialPort = require('serialport');
const XError = require('xerror');
const pasync = require('pasync');

class TinyGController extends Controller {

	constructor(config = {}) {
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
		while (this.linesToSend >= 1 && this.sendQueue.length >= 1) {
			this._sendImmediate(this.sendQueue.shift(), this.responseWaiterQueue.shift());
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
		if (line === '!' || line === '%' || line === '~') {
			this.serial.write(line);
			if (responseWaiter) responseWaiter.reject(new XError(XError.INVALID_ARGUMENT, 'Cannot wait for response on control character'));
		} else {
			this.serial.write(line + '\n');
			this.linesToSend--;
			this.responseWaiters.push(responseWaiter);
		}
	}

	// Push a line onto the send queue to be sent when buffer space is available
	send(line) {
		this.sendQueue.push(line);
		this.responseWaiterQueue.push(null);
		this._doSend();
	}

	async waitSync() {
		// Fetch new status report to ensure up-to-date info (mostly in case a move was just requested and we haven't gotten an update from that yet)
		await this.sendWait({ sr: null });
		// If the planner queue is empty, and we're not currently moving, then should be good
		if (!this.moving && this.plannerQueueFree === this.plannerQueueSize) return Promise.resolve();
		// Otherwise, register a listener for status changes, and resolve when these conditions are met
		await new Promise((resolve, reject) => {
			if (this.error) return reject(new XError(XError.MACHINE_ERROR, 'Machine error code: ' + this.errorData));
			const statusHandler = () => {
				if (this.error) {
					this.removeListener('statusUpdate', statusHandler);
					reject(new XError(XError.MACHINE_ERROR, 'Machine error code: ' + this.errorData));
				} else if (!this.moving && this.plannerQueueFree === this.plannerQueueSize) {
					this.removeListener('statusUpdate', statusHandler);
					resolve();
				}
			};
			this.on('statusUpdate', statusHandler);
		});
	}

	_handleReceiveSerialDataLine(line) {
		if (line[0] != '{') throw new XError(XError.PARSE_ERROR, 'Errror parsing received serial line', { data: line });
		let data = JSON.parse(line);
		let statusVars = {}; // updated status vars
		if ('sr' in data) {
			// Update the current status variables
			for (let key in data.sr) statusVars[key] = data.sr[key];
		}
		if ('qr' in data) {
			// Update queue report
			statusVars.qr = data.qr;
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
				csysName = 'g5' + (4 + csys);
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
					vars.push('g5' + (4 + csys));
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
		// Set automatic status report interval
		await this.sendWait({ si: this.config.statusReportInterval || 250 });
		// Configure status report fields
		await this.sendWait({ sr: false }); // to work with future firmware versions where status report variables are configured incrementally
		let srVars = [ 'n', 'feed', 'stat', 'qr' ];
		for (let axis of this.axisLabels) { srVars.push('mpo' + axis); }
		let srConfig = {};
		for (let name of srVars) { srConfig[name] = true; }
		await this.sendWait({ sr: srConfig });
		// Fetch initial state
		await this._fetchStatus(null, false);
		// Set the planner queue size to the number of free entries (it's currently empty)
		this.plannerQueueSize = this.plannerQueueFree;
	}

	_setupSerial() {
		const handlePortClosed = () => {
			// TODO: Retry opening it
		};

		this.serial.on('error', (err) => {
			this.emit('error', new XError(XError.COMM_ERROR, 'Serial port error', err));
			handlePortClosed();
		});

		this.serial.on('close', () => {
			handlePortClosed();
		});

		let receiveBuf = '';
		this.sendQueue = [];
		this.responseWaiterQueue = [];
		this.responseWaiters = [];
		this.linesToSend = 4;
		this._waitingForSync = false;
		this.currentStatusReport = {};

		this.serial.on('data', (buf) => {
			let str = receiveBuf + buf.toString('utf8');
			let strlines = str.split(/[\r\n]+/);
			if (!strlines[strlines.length-1].trim()) {
				// Received data ended in a newline, so don't need to buffer anything
				strlines.pop();
				receiveBuf = '';
			} else {
				// Last line did not end in a newline, so add to buffer
				receiveBuf = strlines.pop();
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

};

module.exports = TinyGController;



