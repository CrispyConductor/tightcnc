const Controller = require('./controller');
const SerialPort = require('serialport');
const XError = require('xerror');
const pasync = require('pasync');
const GcodeLine = require('../../lib/gcode-line');
const CrispHooks = require('crisphooks');
const objtools = require('objtools');
const GcodeVM = require('../../lib/gcode-vm');

class GRBLController extends Controller {

	constructor(config = {}) {
		super(config);

		this.serial = null;
		this._initializing = false;
		this._resetting = false;
		this._serialListeners = {};

		this.sendQueue = [];
		// This is the index into sendQueue of the next entry to send to the device.  Can be 1 past the end of the queue if there are no lines queued to be sent.
		this.sendQueueIdxToSend = 0;
		// This is the index into sendQueue of the next entry that has been sent but a response is expected for.
		this.sendQueueIdxToReceive = 0;
		// Total number of chars that might be in the grbl serial buffer
		this.unackedCharCount = 0;

		// For certain operations, this interface class uses the concept of a "machine timestamp".  It's kinda
		// like an epoch timestamp, but start at the time this class was instantiated, and does not include
		// time spent in a feed hold.  These variables are involved in calculating machine time.
		this.machineTimeBaseline = new Date().getTime();
		this.totalHeldMachineTime = 0;
		this.lastHoldStartTime = null;

		// The machine timestamp that the most recent line began executing
		this.lastLineExecutingTime = null;
		this.timeEstVM = new GcodeVM();
		this._checkExecutedLoopTimeout = null;

		// Number of blocks in sendQueue to send immediately even if it would exceed normal backpressure
		this.sendImmediateCounter = 0;
		this._disableSending = false;

		this.currentStatusReport = {};

		this.axisLabels = [ 'x', 'y', 'z' ];
		this.usedAxes = config.usedAxes || [ true, true, true ];
		this.homableAxes = config.homableAxes || [ true, true, true ];
		this.axisMaxFeeds = config.axisMaxFeeds || [ 500, 500, 500 ];

		// Mapping from a parameter key to its value (keys include things like G54, PRB, as well as VER, OPT - values are parsed)
		this.receivedDeviceParameters = {};
		// Mapping from a grbl settings index (numeric) to its value
		this.grblSettings = {};

		this._makeRegexes();

		this.toolLengthOffset = 0;

		this.grblDeviceVersion = null; // main device version, from welcome message
		this.grblVersionDetails = null; // version details, from VER feedback message
		this.grblBuildOptions = {}; // build option flags and values, from OPT feedback message

		this._lastRecvSrOrAck = null; // used as part of sync detection

		// used for jogging
		this.realTimeMovesTimeStart = [ 0, 0, 0, 0, 0, 0 ];
		this.realTimeMovesCounter = [ 0, 0, 0, 0, 0, 0 ];
	}

	_getCurrentMachineTime() {
		let ctime = new Date().getTime();
		let mtime = ctime - this.machineTimeBaseline;
		mtime -= this.totalHeldMachineTime;
		if (this.held) {
			mtime -= (ctime - this.lastHoldStartTime);
		}
		return mtime;
	}

	debug(str) {
		const enableDebug = false;
		if (this.tightcnc) this.tightcnc.debug('TinyG: ' + str);
		else if (enableDebug) console.log('Debug: ' + str);
	}

	_commsReset(err = null) {
		this.debug('_commsReset()');
		if (!err) err = new XError(XError.INTERNAL_ERROR, 'Communications reset');
		// Call the error hook on anything in sendQueue
		for (let entry of this.sendQueue) {
			if (entry.hooks) {
				this.debug('_commsReset triggering error hook on sendQueue entry');
				entry.hooks.triggerSync('error', err);
			}
		}
		this.debug('_commsReset() done triggering error hooks');
		// Reset all the variables
		this.sendQueue = [];
		this.sendQueueIdxToSend = 0;
		this.sendQueueIdxToReceive = 0;
		this.unackedCharCount = 0;
		this.sendImmediateCounter = 0;
		this.emit('_sendQueueDrain');
	}

	getPos() {
		if (this._wpos) return this._wpos;
		else return super.getPos();
	}

	_handleStatusUpdate(obj) {
		let changed = false;
		for (let key in obj) {
			if (!objtools.deepEquals(obj[key], objtools.getPath(this, key))) {
				objtools.setPath(this, key, obj[key]);
				changed = true;
			}
		}
		if (changed) this.emit('statusUpdate');
	}

	_handleReceiveStatusReport(srString) {
		// Parse status report
		// Detect if it's an old-style (0.9) or new style (1.1) status report based on if it contains a pipe
		let statusReport = {};
		let parts;
		if (srString.indexOf('|') === -1) {
			// old style
			// process the string into an array of strings in the form 'key:val'
			parts = srString.split(',');
			for (let i = 0; i < parts.length; ) {
				if (!isNaN(parts[i]) && i > 0) {
					// this part contains no label, so glue it onto the previous part
					parts[i - 1] += ',' + parts[i];
					parts.splice(i, 1);
				} else {
					i++;
				}
			}
		} else {
			// new style, just split on |
			parts = srString.split('|');
		}
		// now parse each element
		for (let i = 0; i < parts.length; i++) {
			let part = parts[i];
			if (i === 0) {
				// Is machine state
				statusReport.machineState = part;
			} else {
				// Split into key and value, then split value on comma if present, parsing numbers
				let matches = this._regexSrSplit.exec(part);
				let key = matches[1];
				let val = matches[2].split(',').map((s) => {
					if (s !== '' && !isNaN(s)) {
						return parseFloat(s);
					} else {
						return s;
					}
				});
				if (val.length === 1) val = val[0];
				statusReport[key] = val;
			}
		}
		// Parsed mapping is now in statusReport

		// Update this.currentStatusReport
		for (let key in statusReport) {
			this.currentStatusReport[key] = statusReport[key];
		}

		// Update the class properties
		let obj = {};

		// Handle each key
		for (let key in statusReport) {
			// Handle each possible key we care about

			if (key === 'machineState') {
				// States: Idle, Run, Hold, Jog (1.1 only), Alarm, Door, Check, Home, Sleep (1.1 only)
				let substate = null;
				let state = statusReport[key];
				if (state.indexOf(':') !== -1) {
					let stateParts = state.split(':');
					state = stateParts[0];
					substate = parseInt(stateParts[1]);
				}
				switch (state.toLowerCase()) {
					case 'idle':
						obj.ready = true;
						obj.held = false;
						obj.moving = false;
						obj.error = false;
						obj.errorData = null;
						obj.programRunning = false;
						break;
					case 'run':
						obj.ready = true;
						obj.held = false;
						obj.moving = true;
						obj.error = false;
						obj.errorData = null;
						obj.programRunning = true;
						break;
					case 'hold':
						obj.ready = true;
						obj.held = true;
						obj.moving = false;
						obj.error = false;
						obj.errorData = null;
						obj.programRunning = true;
						break;
					case 'alarm':
						obj.ready = false;
						obj.held = false;
						obj.moving = false;
						obj.error = true;
						obj.errorData = obj.errorData || 'alarm';
						obj.programRunning = false;
						break;
					case 'door':
						obj.ready = false;
						obj.held = false;
						obj.moving = false;
						obj.error = true;
						// TODO: Handle substate with different messages here
						obj.errorData = 'Door';
						obj.programRunning = false;
						break;
					case 'check':
						obj.ready = true;
						obj.held = false;
						obj.moving = false;
						obj.error = false;
						obj.errorData = null;
						obj.programRunning = true;
						break;
					case 'home':
					case 'jog':
						obj.ready = true;
						obj.held = false;
						obj.moving = true;
						obj.error = false;
						obj.errorData = null;
						break;
					case 'sleep':
						break;
					default:
						// Unknown state
						break;
				}
			} else if (key === 'Bf') {
				// Not currently used.  At some point in the future, if this field is present, it can be used to additionally inform when executing and executed are called, and for waitSync
			} else if (key === 'Ln') {
				obj.line = statusReport.Ln;
			} else if (key === 'F') {
				obj.feed = statusReport.F;
			} else if (key === 'FS') {
				obj.feed = statusReport.FS[0];
				obj.spindleSpeed = statusReport.FS[1];
			} else if (key === 'Pn') {
				// pin state; currently not used
			} else if (key === 'Ov') {
				// currently unused; possible integration with runtime-overrides plugin
			} else if (key === 'A') {
				let a = statusReport.A;
				if (a.indexOf('S') !== -1) {
					obj.spindle = true;
					obj.spindleDirection = 1;
				} else if (a.indexOf('C' !== -1)) {
					obj.spindle = true;
					obj.spindleDirection = -1;
				} else {
					obj.spindle = false;
				}
				if (a.indexOf('F') !== -1) {
					if (a.indexOf('M') !== -1) {
						obj.coolant = 3;
					} else {
						obj.coolant = 2;
					}
				} else if (a.indexOf('M') !== -1) {
					obj.coolant = 1;
				} else {
					obj.coolant = false;
				}
			} else if (key === 'Buf') { // 0.9
				// As with 'Bf' above, could possibly be used to additional inform when to call hooks and syncing
			} else if (key === 'RX') { // 0.9
				// not used
			} else if (key !== 'MPos' && key !== 'WPos' && key !== 'WCO') {
				// unknown status field; ignore
			}
		}

		// Figure out how to update current position with given information
		if ('MPos' in statusReport) {
			obj.mpos = statusReport.MPos;
			if ('WCO' in statusReport) {
				// calculate this._wpos from given coordinate offset
				obj._wpos = [];
				for (let i = 0; i < statusReport.MPos.length; i++) obj._wpos.push(statusReport.MPos[i] - statusReport.WCO[i]);
			} else if (!('WPos' in statusReport)) {
				// no work position present, so clear this._wpos so position is calculated from mpos
				obj._wpos = null;
			}
		}
		if ('WPos' in statusReport) {
			obj._wpos = statusReport.WPos;
			if ('WCO' in statusReport && !('MPos' in statusReport)) {
				// calculate this.mpos from the known data
				obj.mpos = [];
				for (let i = 0; i < statusReport.WPos.length; i++) obj.mpos.push(statusReport.WPos[i] + statusReport.WCO[i]);
			}
		}

		this._lastRecvSrOrAck = 'sr';
		this._handleStatusUpdate(obj);
		this.emit('statusReportReceived', statusReport);
	}

	_handleSettingFeedback(setting, value) {
		// parse value
		if (value && !isNaN(value)) value = parseFloat(value);
		// store in this.grblSettings
		let oldVal = this.grblSettings[setting];
		this.grblSettings[setting] = value;
		// check if setting requires updating other status properties
		if (setting === 13) this.grblReportInches = value;
		if (setting === 22) this.homableAxes = value ? (config.homableAxes || [ true, true, true ]) : [ false, false, false ];
		if (setting === 30) this.spindleSpeedMax = value;
		if (setting === 31) this.spindleSpeedMin = value;
		if (setting === 110) this.axisMaxFeeds[0] = value;
		if (setting === 111) this.axisMaxFeeds[1] = value;
		if (setting === 112) this.axisMaxFeeds[2] = value;
		// TODO: handle storing max accel, as well as max travel
		// TODO: sync to gcode vm
		// fire event
		if (value !== oldVal) {
			this.emit('statusUpdate');
			this.emit('settingsUpdate');
		}
	}

	_makeRegexes() {
		// received message regexes
		this._regexWelcome = /^Grbl v?([^ ]+)/; // works for both 0.9 and 1.1
		this._regexOk = /^ok(:(.*))?/; // works for both 0.9 and 1.1
		this._regexError = /^error:(.*)$/; // works for both 0.9 and 1.1
		this._regexStartupLineOk = /^>.*:ok$/; // works for 1.1; not sure about 0.9
		this._regexStartupLineError = /^>.*:error:(.*)$/; // works for 1.1; not sure about 0.9
		this._regexStatusReport = /^<(.*)>$/; // works for both 0.9 and 1.1
		this._regexAlarm = /^ALARM:(.*)$/; // works for both 0.9 and 1.1
		this._regexIgnore = /^\[HLP:.*\]$|^\[echo:.*/; // regex of messages we don't care about but are valid responses from grbl
		this._regexSetting = /^\$([0-9]+)=(-?[0-9.]+)/; // works for 1.1; not sure about 0.9
		this._regexStartupLineSetting = /^\$N([0-9]+)=(.*)$/; // works for 1.1; not sure about 0.9
		this._regexMessage = /^\[MSG:(.*)\]$/; // 1.1 only
		this._regexParserState = /^\[GC:(.*)\]$/; // 1.1 only
		this._regexParamValue = /^\[(G5[4-9]|G28|G30|G92|TLO|PRB|VER|OPT):(.*)\]$/; // 1.1 only
		this._regexFeedback = /^\[(.*)\]$/;

		// regex for splitting status report elements
		this._regexSrSplit = /^([^:]*):(.*)$/;

		// regex for parsing outgoing settings commands
		this._regexSettingsCommand = /^\$(N?[0-9]+)=(.*)$/;
	}

	_handleReceiveSerialDataLine(line) {
		let matches;
		//this.debug('receive line ' + line);
		this.emit('received', line);

		// Check for ok
		if (this._regexOk.test(line)) {
			this._lastRecvSrOrAck = 'ack';
			this._commsHandleAckResponseReceived();
			return;
		}

		// Check for status report
		matches = this._regexStatusReport.exec(line);
		if (matches) {
			this._handleReceiveStatusReport(matches[1]);
			return;
		}

		// Check for ignored line
		if (this._regexIgnore.test(line)) return;

		// Check for error
		matches = this._regexError.exec(line);
		if (matches) {
			this._lastRecvSrOrAck = 'ack';
			let errInfo = matches[1];
			if (errInfo && !isNaN(errInfo)) errInfo = parseInt(errInfo);
			this._commsHandleAckResponseReceived(errInfo);
			return;
		}

		// Check for welcome message
		matches = this._regexWelcome.exec(line);
		if (matches) {
			this.grblDeviceVersion = matches[1];
			if (this._initializing && this._welcomeMessageWaiter) {
				// Complete initialization
				this._welcomeMessageWaiter.resolve();
				return;
			} else if (this._resetting) {
				// Ready again after reset
				this._commsReset();
				this._disableSending = false;
				this._resetting = false;
				this._initMachine()
					.then(() => {
						this.ready = true;
						this.emit('ready');
						this.emit('statusUpdate');
						this.debug('Done resetting');
					})
					.catch((err) => {
						console.error(err);
						this.debug('Error initializing machine after reset: ' + err);
						this.close(err);
						this._retryConnect();
					});
				return;
			} else {
				// Got an unexpected welcome message indicating that the device was reset unexpectedly
				this.debug('Machine reset unexpectedly');
				let err = new XError(XError.CANCELLED, 'Machine reset');
				this.close(err);
				if (!this._initializing) {
					this.debug('calling _retryConnect() after receive welcome message');
					this._retryConnect();
				}
				return;
			}
		}

		// Check if it's a startup line result
		if (this._regexStartupLineOk.test(line)) return; // ignore
		matches = this._regexStartupLineError.exec(line);
		if (matches) {
			this.emit('message', 'Startup line error: ' + line);
			return;
		}

		// Check if it's an alarm
		matches = this._regexAlarm.exec(line);
		if (matches) {
			this.error = true;
			this.ready = false;
			this.moving = false;
			this.errorData = 'Alarm: ' + matches[1];
			let err = new XError(XError.MACHINE_ERROR, 'Alarm: ' + matches[1]);
			this._cancelRunningOps(err);
			if (!this._initializing) this.emit('error', err);
			return;
		}

		// Check if it's a settings response
		matches = this._regexSetting.exec(line);
		if (matches) {
			this._handleSettingFeedback(parseInt(matches[1]), matches[2]);
			return;
		}
		matches = this._regexStartupLineSetting.exec(line);
		if (matches) {
			this._handleSettingFeedback('N' + matches[1], matches[2]);
			return;
		}

		// Check if it's a message
		matches = this._regexMessage.exec(line);
		if (matches) {
			this.emit('message', 'GRBL: ' + matches[1]);
			return;
		}

		// Check if it's parser state feedback
		matches = this._regexParserState.exec(line);
		if (matches) {
			this._handleDeviceParserUpdate(matches[1]);
			return;
		}

		// Check if it's a parameter value
		matches = this._regexParamValue.exec(line);
		if (matches) {
			this._handleDeviceParameterUpdate(matches[1], matches[2]);
			return;
		}

		// Check if it's some other feedback value
		matches = this._regexFeedback.exec(line);
		if (matches) {
			this._handleUnmatchedFeedbackMessage(matches[1]);
			return;
		}

		// Unmatched line
		console.error('Received unknown line from grbl: ' + line);
	}

	_handleDeviceParserUpdate(str) {
		// Ignore this if there's anything in the sendQueue with gcode attached (so we know the controller's parser is in sync)
		for (let entry of this.sendQueue) {
			if (entry.gcode) return;
		}

		// Parse the whole response as a gcode line and run it through the gcode vm
		let gline = new GcodeLine(str);
		this.timeEstVM.runGcodeLine(gline);

		let statusUpdates = {};

		// Fetch gcodes from each relevant modal group and update state vars accordingly
		let activeCoordSys = gline.get('G', 'G54');
		if (activeCoordSys) statusUpdates.activeCoordSys = activeCoordSys - 54;
		let unitCode = gline.get('G', 'G20');
		if (unitCode) statusUpdates.units = (unitCode === 20) ? 'in' : 'mm';
		let incrementalCode = gline.get('G', 'G90');
		if (incrementalCode) statusUpdates.incremental = incrementalCode === 91;
		let feedMode = gline.get('G', 'G93');
		if (feedMode) statusUpdates.inverseFeed = feedMode === 93;
		let spindleMode = gline.get('M', 'M5');
		if (spindleMode === 3) { statusUpdates.spindle = true; statusUpdates.spindleDirection = 1; }
		if (spindleMode === 4) { statusUpdates.spindle = true; statusUpdates.spindleDirection = -1; }
		if (spindleMode === 5) statusUpdates.spindle = false;
		let coolantMode = gline.get('M', 'M7');
		if (coolantMode === 7) statusUpdates.coolant = 1;
		if (coolantMode === 8) statusUpdates.coolant = 2;
		if (coolantMode === 9) statusUpdates.coolant = false;
		let feed = gline.get('F');
		if (typeof feed === 'number') statusUpdates.feed = feed;
		let spindleSpeed = gline.get('S');
		if (typeof spindleSpeed === 'number') statusUpdates.spindleSpeed = spindleSpeed;

		// Perform status updates
		this._handleStatusUpdate(statusUpdates);
	}

	_handleDeviceParameterUpdate(name, value) {
		name = name.toUpperCase();
		// Parse the value.  Supported formats:
		// - <number> - parsed as number
		// - <number>,<number>,<number> - parsed as number array
		// - <value>:<value> - parsed as array of other values (numbers or number arrays)
		value = value.split(':');
		for (let j = 0; j < value.length; j++) {
			let a = value[j];
			let parts = a.split(',');
			for (let i = 0; i < parts.length; i++) {
				if (parts[i] && !isNaN(parts[i])) parts[i] = parseFloat(parts[i]);
			}
			if (parts.length < 2) parts = parts[0];
			value[j] = parts;
		}
		if (name !== 'PRB') value = value[0];

		// Update any status vars
		let statusObj = {};
		if (name[0] === 'G' && name[1] === '5') {
			let n = parseInt(name[2]) - 4;
			if (n >= 0) statusObj['coordSysOffsets.' + n] = value;
		}
		if (name === 'G28') statusObj['storedPositions.0'] = value;
		if (name === 'G30') statusObj['storedPositions.1'] = value;
		if (name === 'G92') statusObj.offset = value;
		if (name === 'TLO') statusObj.toolLengthOffset = value;
		if (name === 'PRB') statusObj.lastProbeReport = value;
		if (name === 'VER') statusObj.grblVersionDetails = value;
		if (name === 'OPT') {
			const optCharMap = {
				'V': 'variableSpindle',
				'N': 'lineNumbers',
				'M': 'mistCoolant',
				'C': 'coreXY',
				'P': 'parking',
				'Z': 'homingForceOrigin',
				'H': 'homingSingleAxis',
				'T': 'twoLimitSwitch',
				'A': 'allowProbeFeedOverride',
				'*': 'disableRestoreAllEEPROM',
				'$': 'disableRestoreSettings',
				'#': 'disableRestoreParams',
				'I': 'disableBuildInfoStr',
				'E': 'disableSyncOnEEPROMWrite',
				'W': 'disableSyncOnWCOChange',
				'L': 'powerUpLockWithoutHoming'
			};
			this.grblBuildOptions = {};
			let optChars = value[0].toUpperCase();
			for (let c of optChars) {
				this.grblBuildOptions[c] = true;
				if (c in optCharMap) {
					this.grblBuildOptions[optCharMap[c]] = true;
				}
			}
			for (let c in optCharMap) {
				if (!this.grblBuildOptions[c]) {
					this.grblBuildOptions[c] = false;
					this.grblBuildOptions[optCharMap[c]] = false;
				}
			}
			this.grblBuildOptions.blockBufferSize = value[1];
			this.grblBuildOptions.rxBufferSize = value[2];
		}
		this._handleStatusUpdate(statusObj);

		// Update parameters mapping
		this.receivedDeviceParameters[name] = value;
		this.emit('deviceParamUpdate', name, value);
	}

	_handleUnmatchedFeedbackMessage(str) {
		this.emit('message', 'GRBL: ' + str);
	}

	_writeToSerial(str) {
		if (!this.serial) return;
		this.serial.write(str);
	}

	_cancelRunningOps(err) {
		this.debug('_cancelRunningOps()');
		this._commsReset(err);
		this.debug('_cancelRunningOps() emitting cancelRunningOps');
		this.emit('cancelRunningOps', err);
		this.debug('_cancelRunningOps() done');
	}

	initConnection(retry = true) {
		this.debug('initConnection()');
		if (this._initializing) {
			this.debug('skipping, already initializing');
			return;
		}
		this._retryConnectFlag = retry;
		this.ready = false;
		this._initializing = true;
		this.emit('statusUpdate');

		if (this.serial || this.sendQueue.length) {
			this.close();
		}

		const doInit = async() => {

			// Set up options for serial connection.  (Set defaults, then apply configs on top.)
			let serialOptions = {
				autoOpen: true,
				baudRate: 115200,
				dataBits: 8,
				stopBits: 1,
				parity: 'none',
				rtscts: false,
				xany: false
			};
			for (let key in this.config) {
				if (key in serialOptions) {
					serialOptions[key] = this.config[key];
				}
			}
			let port = this.config.port || '/dev/ttyACM1';

			// Try to open the serial port
			this.debug('Opening serial port');
			await new Promise((resolve, reject) => {
				this.serial = new SerialPort(port, serialOptions, (err) => {
					if (err) reject(new XError(XError.COMM_ERROR, 'Error opening serial port', err));
					else resolve();
				});
			});
			this.debug('Serial port opened');

			// This waiter is used for the pause during initialization later.  It's needed because
			// we need to be able to reject this and exit initialization if an error occurs while paused.
			let initializationPauseWaiter = pasync.waiter();

			// Initialize serial buffers and initial variables
			this.serialReceiveBuf = '';
			this.debug('initConnection calling _commsReset()');
			this._commsReset();

			// Set up serial port communications handlers
			const onSerialError = (err) => {
				this.debug('Serial error ' + err);
				err = new XError(XError.COMM_ERROR, 'Serial port communication error', err);
				if (!this._initializing) this.emit('error', err); // don't emit during initialization 'cause that's handled separately (by rejecting the waiters during close())
				this.close(err);
				this._retryConnect();
			};
			const onSerialClose = () => {
				this.debug('Serial close');
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

			this._welcomeMessageWaiter = pasync.waiter();
			
			// Wait for the welcome message to be received; if not received in 5 seconds, send a soft reset
			const welcomeWaitCancelRunningOpsHandler = (err) => {
				if (this._welcomeMessageWaiter) {
					this._welcomeMessageWaiter.reject(err);
				}
			};
			this.on('cancelRunningOps', welcomeWaitCancelRunningOpsHandler);
			let finishedWelcomeWait = false;
			setTimeout(() => {
				if (!finishedWelcomeWait) {
					this.serial.write('\x18');
				}
			}, 5000);
			try {
				await this._welcomeMessageWaiter.promise;
			} finally {
				finishedWelcomeWait = true;
				this.removeListener('cancelRunningOps', welcomeWaitCancelRunningOpsHandler);
			}

			// Initialize all the machine state properties
			await this._initMachine();

			// Initialization succeeded
			this.ready = true;
			this._initializing = false;
			this.emit('ready');
			this.emit('statusUpdate');
			this.debug('initConnection() done');
		};

		
		doInit()
			.catch((err) => {
				this.debug('initConnection() error ' + err);
				console.log(err);
				this.emit('error', new XError(XError.COMM_ERROR, 'Error initializing connection', err));
				this.close(err);
				this._initializing = false;
				this._retryConnect();
			});
	}

	_retryConnect() {
		this.debug('_retryConnect()');
		if (!this._retryConnectFlag) {
			this.debug('Skipping, retry connect disabled');
			return;
		}
		if (this._waitingToRetry) {
			this.debug('Skipping, already waiting to retry');
			return;
		}
		this._waitingToRetry = true;
		setTimeout(() => {
			this._waitingToRetry = false;
			this.debug('_retryConnect() calling initConnection()');
			this.initConnection(true);
		}, 5000);
	}

	request(line) {
		// send line, wait for ack event or error
		return new Promise((resolve, reject) => {
			let hooks = new CrispHooks();
			let resolved = false;
			hooks.hookSync('ack', () => {
				if (resolved) return;
				resolved = true;
				resolve();
			});
			hooks.hookSync('error', (err) => {
				if (resolved) return;
				resolved = true;
				reject(err);
			});
			this.send(line, { hooks: hooks });
		});
	}

	_waitForEvent(eventName, condition = null) {
		// wait for the given event, or a cancelRunningOps event
		// return when the condition is true
		return new Promise((resolve, reject) => {
			let finished = false;
			let eventHandler, errorHandler;
			eventHandler = (...args) => {
				if (finished) return;
				if (condition && !condition(...args)) return;
				this.removeListener(eventName, eventHandler);
				this.removeListener('cancelRunningOps', errorHandler);
				finished = true;
				resolve(args[0]);
			};
			errorHandler = (err) => {
				if (finished) return;
				this.removeListener(eventName, eventHandler);
				this.removeListener('cancelRunningOps', errorHandler);
				finished = true;
				reject(err);
			};
			this.on(eventName, eventHandler);
			this.on('cancelRunningOps', errorHandler);
		});
	}

	_startStatusUpdateLoops() {
		if (this._statusUpdateLoops) return;
		this._statusUpdateLoops = [];
		const startUpdateLoop = (interval, fn) => {
			let fnIsRunning = false;
			let ival = setInterval(() => {
				if (!this.serial) return;
				if (fnIsRunning) return;
				fnIsRunning = true;
				fn()
					.then(() => { fnIsRunning = false; }, (err) => { fnIsRunning = false; throw err; })
					.catch((err) => this.emit('error', err));
			}, interval);
			this._statusUpdateLoops.push(ival);
		};

		startUpdateLoop(this.config.statusUpdateInterval || 250, async() => {
			if (this.serial) this.send('?');
		});
	}

	_stopStatusUpdateLoops() {
		if (!this._statusUpdateLoops) return;
		for (let ival of this._statusUpdateLoops) clearInterval(ival);
		this._statusUpdateLoops = null;
	}

	async fetchUpdateStatusReport() {
		this.send('?');
		return await this._waitForEvent('statusReportReceived');
	}

	async fetchUpdateSettings() {
		await this.request('$N');
		return await this.request('$$');
	}

	async fetchUpdateParameters() {
		await this.request('$I');
		await this.request('$#');
	}

	async fetchUpdateParserParameters() {
		await this.request('$G');
	}

	async _initMachine() {
		await this.fetchUpdateParameters();
		await this.fetchUpdateSettings();
		await this.fetchUpdateStatusReport();
		await this.fetchUpdateParserParameters();
		this.timeEstVM.syncStateToMachine({ controller: this });
		this._startStatusUpdateLoops();
	}

	_sendBlock(block, immediate = false) {
		//this.debug('_sendBlock() ' + block.str);
		if (!this.serial) throw new XError(XError.INTERNAL_ERROR, 'Cannot send, no serial connection');
		block.responseExpected = true; // note: real-time commands are picked off earlier and not handled here

		if (immediate) {
			this._sendBlockImmediate(block);
			return;
		}
		this.sendQueue.push(block);
		if (block.hooks) block.hooks.triggerSync('queued', block);
		this._checkSendLoop();
	}

	// Pushes a block onto the sendQueue such that it will be next to be sent, and force it to be sent immediately.
	_sendBlockImmediate(block) {
		//this.debug('_sendBlockImmediate() ' + block.str);
		if (!this.serial) throw new XError(XError.INTERNAL_ERROR, 'Cannot send, no serial connection');
		block.responseExpected = true;

		// Insert the block where it needs to go in the send queue (as the next to send)
		this.sendQueue.splice(this.sendQueueIdxToSend, 0, block);
		if (block.hooks) block.hooks.triggerSync('queued', block);

		// Force sending this block
		this.sendImmediateCounter++;
		this._checkSendLoop();
	}

	// Will continue looping (asynchronously) and shifting off the front of sendQueue as long
	// as there's stuff to shift off.
	_commsCheckExecutedLoop() {
		if (this._checkExecutedLoopTimeout !== null) {
			// there's already a timeout running
			return;
		}
		// shift off the front of send queue (calling executed hooks) for everything that we think has been executed
		let mtime = this._getCurrentMachineTime();
		// If the grbl planner block buffer is full, don't shift here (we can more accurately determine execution time by when we receive the next ack)
		// This only works in certain circumstances
		if (!(
			this.grblBuildOptions.blockBufferSize && // we can only reliably do this if we definitively know grbl's planner buffer size
			this.sendQueueIdxToReceive >= this.grblBuildOptions.blockBufferSize && // check if grbl's planner is full
			this.sendQueueIdxToSend > this.sendQueueIdxToReceive // at least 1 unacked thing must be present, because the check to shift sendQueue occurs on ack
		)) {
			let shiftedAny = false;
			while (this.sendQueueIdxToReceive > 0 && this.sendQueue[0].timeExecuted <= mtime) {
				this._commsShiftSendQueue();
				shiftedAny = true;
			}
			if (shiftedAny) this._checkSendLoop();
		}
		// if there's something queued at the front of sendQueue, wait until then
		if (this.sendQueueIdxToReceive > 0 && !this._checkExecutedLoopTimeout) {
			const minWait = 100;
			let twait = this.sendQueue[0].timeExecuted - mtime;
			if (twait < minWait) twait = minWait;
			this._checkExecutedLoopTimeout = setTimeout(() => {
				this._checkExecutedLoopTimeout = null;
				this._commsCheckExecutedLoop();
			}, twait);
		}
	}

	_commsShiftSendQueue() {
		if (!this.sendQueue.length || !this.sendQueueIdxToReceive) return;
		let entry = this.sendQueue.shift();
		this.sendQueueIdxToSend--;
		this.sendQueueIdxToReceive--;
		if (entry.hooks) entry.hooks.triggerSync('executed', entry);
		if (this.sendQueue.length && this.sendQueueIdxToReceive) {
			this.lastLineExecutingTime = this._getCurrentMachineTime();
			if (entry.hooks) entry.hooks.triggerSync('executing', entry);
		}
		if (!this.sendQueue.length) this.emit('_sendQueueDrain');
	}

	_commsHandleAckResponseReceived(error = null) {
		if (this.sendQueueIdxToReceive >= this.sendQueueIdxToSend) {
			// Got a response we weren't expecting; ignore it
			return;
		}
		let entry = this.sendQueue[this.sendQueueIdxToReceive];
		if (entry.charCount === undefined) throw new XError(XError.INTERNAL_ERROR, 'GRBL communications desync');
		this.unackedCharCount -= entry.charCount;

		if (error === null) {
			if (entry.hooks) entry.hooks.triggerSync('ack', entry);
			this.emit('receivedOk', entry);
			// If we're not expecting this to go onto the planner queue, splice it out of the list now.  Otherwise,
			// increment the receive pointer.
			const everythingToPlanner = true; // makes gline hooks execute in order
			if (entry.goesToPlanner || (everythingToPlanner && this.sendQueueIdxToReceive > 0)) {
				// Bump this index to move the entry along the sendQueue
				this.sendQueueIdxToReceive++;
				// Estimate how long this block will take to run once it starts executing
				let estBlockDuration = 0;
				if (entry.gcode) {
					let { time } = this.timeEstVM.runGcodeLine(entry.gcode);
					if (time) estBlockDuration = time * 1000;
				}
				entry.duration = estBlockDuration;
				// Estimate a machine timestamp of when this block will have executed
				if (this.sendQueueIdxToReceive >= 2 && this.lastLineExecutingTime) {
					// there's a line currently executing, so base eta off of that line's executed time
					entry.timeExecuted = this.sendQueue[0].timeExecuted;
					// add in everything in the planner buffer between the head and this instructions (including this instruction)
					// TODO: optimize out this loop by storing this value as a running tally
					for (let i = 1; i < this.sendQueueIdxToReceive; i++) entry.timeExecuted += this.sendQueue[i].duration;
				} else {
					// this line will start to execute right now, so base eta on current time
					entry.timeExecuted = this._getCurrentMachineTime() + estBlockDuration;
				}
				// Handle case that the entry is at the head of the sendQueue
				if (this.sendQueueIdxToReceive === 1) {
					// just received response for entry at head of send queue, so assume it's executing now.
					this.lastLineExecutingTime = this._getCurrentMachineTime();
					if (entry.hooks) entry.hooks.triggerSync('executing', entry);
				}
				// If our estimated size of grbl's planner queue is larger than its max size, shift off the front of sendQueue until down to size
				let grblMaxPlannerFill = 18;
				if (this.grblBuildOptions.blockBufferSize) grblMaxPlannerFill = this.grblBuildOptions.blockBufferSize;
				while (this.sendQueueIdxToReceive > grblMaxPlannerFill) {
					this._commsShiftSendQueue();
				}
			} else {
				// No response is expected, or we're at the head of the sendQueue.  So splice the entry out of the queue and call the relevant hooks.
				this.sendQueue.splice(this.sendQueueIdxToReceive, 1);
				this.sendQueueIdxToSend--; // need to adjust this for the splice
				// Run through VM
				if (entry.gcode) this.timeEstVM.runGcodeLine(entry.gcode);
				if (entry.hooks) {
					this.lastLineExecutingTime = this._getCurrentMachineTime();
					entry.hooks.triggerSync('executing', entry);
					entry.hooks.triggerSync('executed', entry);
				}
				if (!this.sendQueue.length) this.emit('_sendQueueDrain');
			}
		} else {
			// Got an error on the request.  Splice it out of sendQueue, and call the error hook on the gcode line
			this.sendQueue.splice(this.sendQueueIdxToReceive, 1);
			this.sendQueueIdxToSend--; // need to adjust this for the splice
			if (entry.hooks) {
				entry.hooks.triggerSync('error', new XError(XError.INTERNAL_ERROR, 'Received error code from request to GRBL: ' + error));
			}
			if (!this.sendQueue.length) this.emit('_sendQueueDrain');
		}

		this._commsCheckExecutedLoop();
		this._checkSendLoop();
	}

	_checkSendLoop() {
		//this.debug('_checkSendLoop()');
		while (this.sendQueueIdxToSend < this.sendQueue.length && this._checkSendToDevice(this.sendQueue[this.sendQueueIdxToSend].str.length + 1, this.sendImmediateCounter > 0)) {
			//this.debug('_checkSendLoop() iteration');
			let entry = this.sendQueue[this.sendQueueIdxToSend];
			this._writeToSerial(entry.str + '\n');
			entry.charCount = entry.str.length + 1;
			this.unackedCharCount += entry.charCount;
			this.sendQueueIdxToSend++;
			if (this.sendImmediateCounter > 0) this.sendImmediateCounter--;

			if (entry.hooks) {
				entry.hooks.triggerSync('sent', entry);
			}
			this.emit('sent', entry.str);
		}

		// If the next entry queued to receive a response doesn't actually expect a response, generate a "fake" response for it
		// Since _commsHandleAckResponseReceived() calls _checkSendLoop() after it's finished, this process continues for subsequent entries
		if (this.sendQueueIdxToReceive < this.sendQueueIdxToSend && !this.sendQueue[this.sendQueueIdxToReceive].responseExpected) {
			//this.debug('_checkSendLoop() call _commsHandleAckResponseReceived');
			this._commsHandleAckResponseReceived();
		}
	}

	// if preferImmediate is true, this function returns true if it's at all possible to send anything at all to the device
	_checkSendToDevice(charCount, preferImmediate = false) {
		let bufferMaxFill = 115;
		let absoluteBufferMaxFill = 128;
		if (this.grblBuildOptions.rxBufferSize) {
			absoluteBufferMaxFill = this.grblBuildOptions.rxBufferSize;
			bufferMaxFill = absoluteBufferMaxFill - 13;
		}

		if (this._disableSending && !preferImmediate) return false;
		// Don't send in cases where line requests fullSync
		if (this.sendQueue.length > this.sendQueueIdxToSend && this.sendQueueIdxToSend > 0 && this.sendQueue[this.sendQueueIdxToSend].fullSync) {
			// If next line to send requires fullSync, do not send it until the rest of sendQueue is empty (indicating all previously sent lines have been executed)
			return false;
		}
		if (this.sendQueue.length && this.sendQueue[0].fullSync && this.sendQueueIdxToSend > 0) {
			// If a fullSync line is currently running, do not send anything more until it finishes
			return false;
		}
		if (this.unackedCharCount === 0) return true; // edge case to handle if charCount is greater than the buffer size; shouldn't happen, but this prevents it from getting "stuck"
		if (this.unackedCharCount + charCount > (preferImmediate ? absoluteBufferMaxFill : bufferMaxFill)) return false;
		return true;
	}

	_isImmediateCommand(str) {
		str = str.trim();
		return str === '!' || str === '?' || str === '~' || str === '\x18';
	}

	_handleSendImmediateCommand(str) {
		str = str.trim();
		this._writeToSerial(str);
		this.emit('sent', str);
		if (str === '?') {
			// status report request; no current additional action
		} else if (str === '!') {
			if (!this.held) {
				this.held = true;
				this.lastHoldStartTime = new Date().getTime();
			}
		} else if (str === '~') {
			if (this.held) {
				this.totalHeldMachineTime += new Date().getTime() - this.lastHoldStartTime;
				this.lastHoldStartTime = null;
				this.held = false;
			}
		} else if (str === '\x18') {
			if (!this._isSynced() && !this.held) {
				this.homed = [ false, false, false ];
			}
			// disable sending until welcome message is received
			this._disableSending = true;
			this.emit('_sendingDisabled');
			this._resetting = true;
			this.ready = false;
			this.emit('statusUpdate');
			// wait for welcome message to be received; rest of reset is handled in received line handler
		}
	}

	_gcodeLineRequiresSync(gline) {
		// things that touch the eeprom
		return gline.has('G10') || gline.has('G28.1') || gline.has('G30.1') || gline.get('G', 'G54') || gline.has('G28') || gline.has('G30');
	}

	sendGcode(gline, options = {}) {
		let hooks = options.hooks || (gline.triggerSync ? gline : new CrispHooks());
		hooks.hookSync('executing', () => this._updateStateFromGcode(gline));
		this._sendBlock({
			str: gline.toString(),
			hooks: hooks,
			gcode: gline,
			goesToPlanner: 1,
			fullSync: this._gcodeLineRequiresSync(gline)
		}, options.immediate);
	}

	sendLine(str, options = {}) {
		// Check for "immediate commands" like feed hold that don't go into the queue
		if (this._isImmediateCommand(str)) {
			//this._writeToSerial(str);
			this._handleSendImmediateCommand(str);
			return;
		}
		// If it doesn't start with $, try to parse as gcode
		if (str.length && str[0] !== '$') {
			let gcode = null;
			try {
				gcode = new GcodeLine(str);
			} catch (err) {}
			if (gcode) {
				this.sendGcode(gcode, options);
				return;
			}
		}

		let hooks = options.hooks || new CrispHooks();
		let block = {
			str: str,
			hooks: hooks,
			gcode: null,
			goesToPlanner: 0,
			fullSync: true
		};

		// Register hook to update state when this executes
		hooks.hookSync('ack', () => this._updateStateOnOutgoingCommand(block));

		// If can't parse as gcode (or starts with $), send as plain string
		this._sendBlock(block, options.immediate);
	}

	_updateStateOnOutgoingCommand(block) {
		let cmd = block.str.trim();
		let matches;

		// Once homing is complete, set homing status
		if (cmd === '$H') {
			this.homed = [];
			for (let axisNum = 0; axisNum < this.axisLabels.length; axisNum++) this.homed.push(!!this.usedAxes[axisNum]);
		}

		matches = this._regexSettingsCommand.exec(cmd);
		if (matches) {
			this._handleSettingFeedback(matches[1], matches[2]);
		}
	}

	_updateStateFromGcode(gline) {
		this.debug('_updateStateFromGcode: ' + gline.toString());
		// Do not update state components that we have definite values for from status reports based on if we've ever received such a key in this.currentStatusReport

		let statusUpdates = {};

		// Need to handle F even in the case of simple moves (in case grbl doesn't report it back to us), so do that first
		if (gline.has('F') && !('F' in this.currentStatusReport || 'FS' in this.currentStatusReport)) {
			statusUpdates.feed = gline.get('F');
		}

		// Shortcut case for simple common moves which don't need to be tracked here
		let isSimpleMove = true;
		for (let word of gline.words) {
			if (word[0] === 'G' && word[1] !== 0 && word[1] !== 1) { isSimpleMove = false;  break; }
			if (word[0] !== 'G' && word[0] !== 'X' && word[0] !== 'Y' && word[0] !== 'Z' && word[0] !== 'A' && word[0] !== 'B' && word[0] !== 'C' && word[0] !== 'F') {
				isSimpleMove = false;
				break;
			}
		}
		if (isSimpleMove) {
			this._handleStatusUpdate(statusUpdates);
			return;
		}

		let zeropoint = [];
		for (let i = 0; i < this.axisLabels.length; i++) zeropoint.push(0);

		if (gline.has('G10') && gline.has('L2') && gline.has('P')) {
			let csys = gline.get('P') - 1;
			statusUpdates['coordSysOffsets.' + csys] = [];
			for (let axisNum = 0; axisNum < this.axisLabels.length; axisNum++) {
				let axis = this.axisLabels[axisNum].toUpperCase();
				let val = 0;
				if (gline.has(axis)) val = gline.get(axis);
				statusUpdates['coordSysOffsets.' + csys][axisNum] = val;
			}
		}
		if (gline.has('G20') || gline.has('G21')) {
			statusUpdates.units = gline.has('G20') ? 'in' : 'mm';
		}
		if (gline.has('G28.1') || gline.has('G30.1')) {
			let posnum = gline.has('G28.1') ? 0 : 1;
			statusUpdates['storedPositions.' + posnum] = this.mpos.slice();
		}
		let csysCode = gline.get('G', 'G54');
		if (csysCode && csysCode >= 54 && csysCode <= 59 && Math.floor(csysCode) === csysCode) {
			statusUpdates.activeCoordSys = csysCode - 54;
		}
		if (gline.has('G90') || gline.has('G91')) {
			statusUpdates.incremental = gline.has('G91');
		}
		if (gline.has('G92')) {
			statusUpdates.offset = [];
			for (let axisNum = 0; axisNum < this.axisLabels.length; axisNum++) {
				let axis = this.axisLabels[axisNum].toUpperCase();
				if (gline.has(axis)) statusUpdates.offset[axisNum] = gline.get(axis);
				else statusUpdates.offset[axisNum] = 0;
			}
			statusUpdates.offsetEnabled = true;
		}
		if (gline.has('G92.1')) {
			statusUpdates.offset = zeropoint;
			statusUpdates.offsetEnabled = false;
		}
		if (gline.has('G92.2')) {
			statusUpdates.offsetEnabled = false;
		}
		if (gline.has('G92.3')) {
			statusUpdates.offsetEnabled = true;
		}
		if (gline.has('G93') || gline.has('G94')) {
			statusUpdates.inverseFeed = gline.has('G93');
		}
		if (gline.has('M2') || gline.has('M30')) {
			statusUpdates.offset = zeropoint;
			statusUpdates.offsetEnabled = false;
			statusUpdates.activeCoordSys = 0;
			statusUpdates.incremental = false;
			statusUpdates.spindle = false;
			statusUpdates.coolant = false;
		}
		if (gline.has('M3') || gline.has('M4') || gline.has('M5')) {
			statusUpdates.spindle = !gline.has('M5');
			statusUpdates.spindleDirection = gline.has('M4') ? -1 : 1;
			statusUpdates.spindleSpeed = gline.get('S') || null;
		}
		if (gline.has('M7') || gline.has('M8') || gline.has('M9')) {
			if (gline.has('M7')) statusUpdates.coolant = 1;
			else if (gline.has('M8')) statusUpdates.coolant = 2;
			else statusUpdates.coolant = false;
		}

		this._handleStatusUpdate(statusUpdates);
	}

	close(err = null) {
		this.debug('close() ' + err);
		this._stopStatusUpdateLoops();
		if (err && !this.error) {
			this.error = true;
			this.errorData = err;
		}
		this.ready = false;
		this.debug('close() calling _cancelRunningOps()');
		this._cancelRunningOps(err || new XError(XError.CANCELLED, 'Operations cancelled due to close'));
		if (this.serial) {
			this.debug('close() removing listeners from serial');
			for (let key in this._serialListeners) {
				this.serial.removeListener(key, this._serialListeners[key]);
			}
			this._serialListeners = [];
			this.serial.on('error', () => {}); // swallow errors on this port that we're discarding
			this.debug('close() Trying to close serial');
			try { this.serial.close(); } catch (err2) {}
			this.debug('close() done closing serial');
			delete this.serial;
		}
		this.emit('statusUpdate');
		this.debug('close() complete');
	}

	sendStream(stream) {
		let waiter = pasync.waiter();

		// Bounds within which to stop and start reading from the stream.  These correspond to the number of queued lines
		// not yet sent to the controller.
		let sendQueueHighWater = this.config.streamSendQueueHighWaterMark || 20;
		let sendQueueLowWater = this.config.streamSendQueueLowWaterMark || Math.min(10, Math.floor(sendQueueHighWater / 5));
		let streamPaused = false;
		let canceled = false;

		const numUnsentLines = () => {
			return this.sendQueue.length - this.sendQueueIdxToSend;
		};

		const sentListener = () => {
			// Check if paused stream can be resumed
			if (numUnsentLines() <= sendQueueLowWater) {
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

		stream.on(stream._isZStream ? 'chainerror' : 'error', (err) => {
			if (canceled) return;
			this.removeListener('sent', sentListener);
			this.removeListener('cancelRunningOps', cancelHandler);
			waiter.reject(err);
			canceled = true;
		});

		this.on('sent', sentListener);

		stream.on('data', (chunk) => {
			if (canceled) return;
			if (!chunk) return;
			this.send(chunk);
			// if send queue is too full, pause the stream
			if (numUnsentLines() >= sendQueueHighWater) {
				stream.pause();
				streamPaused = true;
			}
		});

		stream.on('end', () => {
			if (canceled) return;
			this.removeListener('sent', sentListener);
			this.removeListener('cancelRunningOps', cancelHandler);
			this.waitSync()
				.then(() => waiter.resolve(), (err) => waiter.reject(err));
		});

		this.on('cancelRunningOps', cancelHandler);

		return waiter.promise;
	}

	_isSynced() {
		return this.currentStatusReport.machineState.toLowerCase() === 'idle' &&
			(this.sendQueue.length === 0 || (this._disableSending && this.sendQueueIdxToReceive === this.sendQueueIdxToSend)) &&
			this._lastRecvSrOrAck === 'sr';
	}

	waitSync() {
		// Consider the machine to be synced when all of these conditions hold:
		// 1) The machine state indicated by the last received status report indicates that the machine is not moving
		// 2) this.sendQueue is empty (or sending is disabled, and all lines sent out have been processed)
		// 3) A status report has been received more recently than the most recent ack
		//
		// Check if these conditions hold immediately.  If not, send out a status report request, and
		// wait until the conditions become true.
		if (this.error) return Promise.reject(new XError(XError.MACHINE_ERROR, 'Machine error code: ' + this.errorData));
		if (this._isSynced()) return Promise.resolve();	
		this.send('?');

		return new Promise((resolve, reject) => {
			const checkSyncHandler = () => {
				if (this.error) {
					reject(new XError(XError.MACHINE_ERROR, 'Machine error code: ' + this.errorData));
					removeListeners();
				} else if (this._isSynced()) {
					resolve();
					removeListeners();
				}
			};
			const checkSyncErrorHandler = (err) => {
				reject(err);
				removeListeners();
			};
			const removeListeners = () => {
				this.removeListener('cancelRunningOps', checkSyncErrorHandler);
				this.removeListener('_sendQueueDrain', checkSyncHandler);
				this.removeListener('_sendingDisabled', checkSyncHandler);
			};
			this.on('cancelRunningOps', checkSyncErrorHandler);
			// events that can cause a sync: sr received, this.sendQueue drain, sending disabled
			this.on('statusReportReceived', checkSyncHandler);
			this.on('_sendQueueDrain', checkSyncHandler);
			this.on('_sendingDisabled', checkSyncHandler);
		});
	}

	hold() {
		this.sendLine('!');
	}

	resume() {
		this.sendLine('~');
	}

	cancel() {
		// grbl doesn't really distinguish between a planner buffer wipe and a reset, so do the same thing for both
		this.hold();
		// Timeout is to ensure that grbl receives the hold and stops so it can preserve its location on reset
		this.setTimeout(() => this.reset(), 500);
	}

	reset() {
		if (!this.serial) return; // no reason to soft-reset GRBL without active connection
		if (!this._initializing && !this._resetting) {
			this.sendLine('\x18');
		}
	}

	async home() {
		if (!this.homableAxes || !this.homableAxes.some((v) => v)) {
			throw new XError(XError.INVALID_ARGUMENT, 'No axes configured to be homed');
		}
		await this.request('$H');
	}

	async move(pos, feed = null) {
		let gcode = feed ? 'G1' : 'G0';
		for (let axisNum = 0; axisNum < pos.length; axisNum++) {
			if (typeof pos[axisNum] === 'number') {
				gcode += ' ' + this.axisLabels[axisNum].toUpperCase() + pos[axisNum];
			}
		}
		await this.request(gcode);
		await this.waitSync();
	}

	_numInFlightRequests() {
		return this.sendQueue.length - this.sendQueueIdxToReceive;
	}

	realTimeMove(axisNum, inc) {
		// Make sure there aren't too many requests in the queue
		if (this._numInFlightRequests() > (this.config.realTimeMovesMaxQueued || 8)) return false;
		// Rate-limit real time move requests according to feed rate
		let rtmTargetFeed = (this.axisMaxFeeds[axisNum] || 500) * 0.98; // target about 98% of max feed rate
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
		if (feed === null || feed === undefined) feed = 25;
		await this.waitSync();

		// Probe toward point
		let gcode = new GcodeLine('G38.2 F' + feed);
		let cpos = this.getPos();
		for (let axisNum = 0; axisNum < pos.length; axisNum++) {
			if (this.usedAxes[axisNum] && typeof pos[axisNum] === 'number' && pos[axisNum] !== cpos[axisNum]) {
				gcode.set(this.axisLabels[axisNum], pos[axisNum]);
			}
		}
		if (gcode.words.length < 3) throw new XError(XError.INVALID_ARGUMENT, 'Cannot probe toward current position');
		this.send(gcode);

		// Wait for a probe report, or an ack.  If an ack is received before a probe report, send out a param request and wait for the probe report to be returned with that.
		const ackHandler = (block) => {
			if (block.str.trim() !== '$#' && this._numInFlightRequests() < 10) { // prevent infinite loops and built on send queues
				this.send('$#');
			}
		};
		this.on('receivedOk', ackHandler);
		try {
			await this._waitForEvent('deviceParamUpdate', (paramName) => paramName === 'PRB');
		} finally {
			this.removeListener('receivedOk', ackHandler);
		}

		let { tripPos, probeTripped } = this.receivedDeviceParameters.PRB;
		if (!probeTriggered) {
			throw new XError(XError.PROBE_NOT_TRIPPED, 'Probe was not tripped during probing');
		}
		
		// If the probe was successful, move back to the position the probe tripped
		await this.move(tripPos);
		return tripPos;
	}
}


module.exports = GRBLController;

