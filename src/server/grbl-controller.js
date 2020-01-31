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
		this.timeEstVM = new GcodeVM({ maxFeed: [ 1000, 1000, 1000 ], acceleration: [ 36000, 36000, 36000 ] });
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

		this.lastMessage = null;
	}

	_getCurrentMachineTime() {
		let ctime = new Date().getTime();
		let mtime = ctime - this.machineTimeBaseline;
		mtime -= this.totalHeldMachineTime;
		if (this.held && this.lastHoldStartTime) {
			mtime -= (ctime - this.lastHoldStartTime);
		}
		return mtime;
	}

	debug(str) {
		const enableDebug = false;
		if (this.tightcnc) this.tightcnc.debug('GRBL: ' + str);
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
		if (this._checkExecutedLoopTimeout !== null) {
			clearTimeout(this._checkExecutedLoopTimeout);
			this._checkExecutedLoopTimeout = null;
		}
		this.emit('_sendQueueDrain');
	}

	getPos() {
		if (this._wpos) return this._wpos;
		else return super.getPos();
	}

	_handleStatusUpdate(obj) {
		let changed = false;
		let wasReady = this.ready;
		for (let key in obj) {
			if (!objtools.deepEquals(obj[key], objtools.getPath(this, key))) {
				objtools.setPath(this, key, obj[key]);
				changed = true;
			}
		}
		if (changed) this.emit('statusUpdate');
		if (!wasReady && this.ready && !this._initializing && !this._resetting) this.emit('ready');
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

		// Separate the machine state into major and minor components
		if (statusReport.machineState) {
			let state = statusReport.machineState;
			if (state.indexOf(':') !== -1) {
				let stateParts = state.split(':');
				statusReport.machineStateMajor = stateParts[0];
				statusReport.machineStateMinor = parseInt(stateParts[1]);
			} else {
				statusReport.machineStateMajor = statusReport.machineState;
				statusReport.machineStateMinor = null;
			}
		}

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
				let state = statusReport.machineStateMajor;
				let substate = statusReport.machineStateMinor;
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
						if (!this.errorData && !obj.errorData) {
							// got status of alarm without a previous ALARM message indicating the type of alarm (which happens in some cases)
							if (this.lastMessage) {
								// infer the alarm state from the most recent message received
								obj.errorData = this._msgToError(this.lastMessage);
							}
							if (!obj.errorData) obj.errorData = new XError(XError.MACHINE_ERROR, 'Alarmed');
						}
						obj.programRunning = false;
						break;
					case 'door':
						obj.ready = false;
						obj.held = false;
						obj.moving = false;
						obj.error = true;
						// TODO: Handle substate with different messages here
						obj.errorData = new XError(XError.SAFETY_INTERLOCK, 'Door open', { doorCode: substate });
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
			} else if (key !== 'MPos' && key !== 'WPos' && key !== 'WCO' && key !== 'machineStateMajor' && key !== 'machineStateMinor') {
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
		if (setting === 22) this.homableAxes = value ? (this.config.homableAxes || [ true, true, true ]) : [ false, false, false ];
		if (setting === 30) this.spindleSpeedMax = value;
		if (setting === 31) this.spindleSpeedMin = value;
		if (setting === 110) { this.axisMaxFeeds[0] = value; this.timeEstVM.options.maxFeed[0] = value; }
		if (setting === 111) { this.axisMaxFeeds[1] = value; this.timeEstVM.options.maxFeed[1] = value; }
		if (setting === 112) { this.axisMaxFeeds[2] = value; this.timeEstVM.options.maxFeed[2] = value; }
		if (setting === 120) { this.timeEstVM.options.acceleration[0] = value * 3600; }
		if (setting === 121) { this.timeEstVM.options.acceleration[1] = value * 3600; }
		if (setting === 122) { this.timeEstVM.options.acceleration[2] = value * 3600; }
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
		this._regexError = /^error: ?(.*)$/; // works for both 0.9 and 1.1
		this._regexStartupLineOk = /^>.*:ok$/; // works for 1.1; not sure about 0.9
		this._regexStartupLineError = /^>.*:error:(.*)$/; // works for 1.1
		this._regexStatusReport = /^<(.*)>$/; // works for both 0.9 and 1.1
		this._regexAlarm = /^ALARM:(.*)$/; // works for both 0.9 and 1.1
		this._regexIgnore = /^\[HLP:.*\]$|^\[echo:.*/; // regex of messages we don't care about but are valid responses from grbl
		this._regexSetting = /^\$([0-9]+)=(-?[0-9.]+)/; // works forboth 0.9 and 1.1
		this._regexStartupLineSetting = /^\$N([0-9]+)=(.*)$/; // works for 1.1; not sure about 0.9
		this._regexMessage = /^\[MSG:(.*)\]$/; // 1.1 only
		this._regexParserState = /^\[GC:(.*)\]$/; // 1.1 only
		this._regexParserState09 = /^\[(([A-Z]-?[0-9.]+ ?){4,})\]$/; // 0.9 only
		this._regexParamValue = /^\[(G5[4-9]|G28|G30|G92|TLO|PRB|VER|OPT):(.*)\]$/; // 1.1 only
		this._regexVersion09 = /^\[([0-9.]+[a-zA-Z]?\.[0-9]+:.*)\]$/; // 0.9 only
		this._regexFeedback = /^\[(.*)\]$/;

		// regex for splitting status report elements
		this._regexSrSplit = /^([^:]*):(.*)$/;

		// regex for parsing outgoing settings commands
		this._regexSettingsCommand = /^\$(N?[0-9]+)=(.*)$/;
		this._regexRstCommand = /^\$RST=(.*)$/;
	}

	_alarmCodeToError(alarm) {
		if (alarm && !isNaN(alarm)) alarm = parseInt(alarm);
		if (typeof alarm === 'string') alarm = alarm.toLowerCase().trim();
		switch (typeof alarm === 'string' ? alarm.toLowerCase() : alarm) {
			case 1:
				return new XError(XError.LIMIT_HIT, 'Hard limit triggered', { limitType: 'hard', grblAlarm: alarm });
			case 2:
				return new XError(XError.LIMIT_HIT, 'Soft limit triggered', { limitType: 'soft', grblAlarm: alarm });
			case 'hard/soft limit':
				return new XError(XError.LIMIT_HIT, 'Limit hit', { grblAlarm: alarm });
			case 3:
			case 'abort during cycle':
				return new XError(XError.MACHINE_ERROR, 'Position unknown after reset; home machine or clear error', { grblAlarm: alarm, subcode: 'position_unknown'});
			case 4:
				return new XError(XError.PROBE_INITIAL_STATE, 'Probe not in expected initial state', { grblAlarm: alarm });
			case 5:
			case 'probe fail':
				return new XError(XError.PROBE_NOT_TRIPPED, 'Probe was not tripped', { grblAlarm: alarm });
			case 6:
				return new XError(XError.MACHINE_ERROR, 'Reset during homing cycle', { grblAlarm: alarm });
			case 7:
				return new XError(XError.MACHINE_ERROR, 'Door opened during homing', { grblAlarm: alarm });
			case 8:
				return new XError(XError.MACHINE_ERROR, 'Homing did not clear switch', { grblAlarm: alarm });
			case 9:
				return new XError(XError.MACHINE_ERROR, 'Homing switch not found', { grblAlarm: alarm });
			default:
				return new XError(XError.MACHINE_ERROR, 'GRBL Alarm: ' + alarm, { grblAlarm: alarm });
		}
	}

	// Converts the grbl message to an XError
	// Returns null if the message does not indicate an error
	// Note that just receiving a message that can be interpreted as an error doesn't mean the machine is alarmed; that should be checked separately
	_msgToError(str) {
		switch(str.trim()) {
			case "'$H'|'$X' to unlock":
				return new XError(XError.MACHINE_ERROR, 'Position unknown; home machine or clear error', { subcode: 'position_unknown', grblMsg: str });
			case 'Reset to continue':
				return new XError(XError.MACHINE_ERROR, 'Critical error; reset required', { grblMsg: str });
			case 'Check Door':
				return new XError(XError.SAFETY_INTERLOCK, 'Door open', { grblMsg: str });
			case 'Check Limits':
				return new XError(XError.LIMIT_HIT, 'Limit hit', { grblMsg: str });

			case 'Caution: Unlocked':
			case 'Enabled':
			case 'Disabled':
			case 'Pgm End':
			case 'Restoring defaults':
			case 'Restoring spindle':
			case 'Sleeping':
				return null;

			default:
				return new XError(XError.MACHINE_ERROR, 'GRBL: ' + str, { grblMsg: str });
		}
	}

	// Converts an error code from an "error:x" message to an XError
	_responseCodeToError(ecode) {
		if (ecode && !isNaN(ecode)) ecode = parseInt(ecode);
		switch(ecode) {
			case 1:
			case 'Expected command letter':
				return new XError(XError.PARSE_ERROR, 'G-code words consist of a letter and a value. Letter was not found.', { grblErrorCode: 1 });
			case 2:
			case 'Bad number format':
				return new XError(XError.PARSE_ERROR, 'Missing the expected G-code word value or numeric value format is not valid.', { grblErrorCode: 2 });
			case 3:
			case 'Invalid statement':
				return new XError(XError.MACHINE_ERROR, 'Grbl \'$\' system command was not recognized or supported.', { grblErrorCode: 3 });
			case 4:
			case 'Value < 0':
				return new XError(XError.MACHINE_ERROR, 'Negative value received for an expected positive value.', { grblErrorCode: 4 });
			case 5:
			case 'Setting disabled':
				return new XError(XError.MACHINE_ERROR, 'Homing cycle failure. Homing is not enabled via settings.', { grblErrorCode: 5 });
			case 6:
			case 'Value < 3 usec':
				return new XError(XError.MACHINE_ERROR, 'Minimum step pulse time must be greater than 3usec.', { grblErrorCode: 6 });
			case 7:
			case 'EEPROM read fail. Using defaults':
				return new XError(XError.MACHINE_ERROR, 'An EEPROM read failed. Auto-restoring affected EEPROM to default values.', { grblErrorCode: 7 });
			case 8:
			case 'Not idle':
				return new XError(XError.MACHINE_ERROR, 'Grbl \'$\' command cannot be used unless Grbl is IDLE. Ensures smooth operation during a job.', { grblErrorCode: 8 });
			case 9:
			case 'G-code lock':
				return new XError(XError.MACHINE_ERROR, 'G-code commands are locked out during alarm or jog state.', { grblErrorCode: 9 });
			case 10:
			case 'Homing not enabled':
				return new XError(XError.MACHINE_ERROR, 'Soft limits cannot be enabled without homing also enabled.', { grblErrorCode: 10 });
			case 11:
			case 'Line overflow':
				return new XError(XError.MACHINE_ERROR, 'Max characters per line exceeded. Received command line was not executed.', { grblErrorCode: 11 });
			case 12:
			case 'Step rate > 30kHz':
				return new XError(XError.MACHINE_ERROR, 'Grbl \'$\' setting value cause the step rate to exceed the maximum supported.', { grblErrorCode: 12 });
			case 13:
			case 'Check Door':
				return new XError(XError.MACHINE_ERROR, 'Safety door detected as opened and door state initiated.', { grblErrorCode: 13 });
			case 14:
			case 'Line length exceeded':
				return new XError(XError.MACHINE_ERROR, 'Build info or startup line exceeded EEPROM line length limit. Line not stored.', { grblErrorCode: 14 });
			case 15:
			case 'Travel exceeded':
				return new XError(XError.MACHINE_ERROR, 'Jog target exceeds machine travel. Jog command has been ignored.', { grblErrorCode: 15 });
			case 16:
			case 'Invalid jog command':
				return new XError(XError.MACHINE_ERROR, 'Jog command has no \'=\' or contains prohibited g-code.', { grblErrorCode: 16 });
			case 17:
			case 'Setting disabled':
				return new XError(XError.MACHINE_ERROR, 'Laser mode requires PWM output.', { grblErrorCode: 17 });
			case 20:
			case 'Unsupported command':
				return new XError(XError.PARSE_ERROR, 'Unsupported or invalid g-code command found in block.', { grblErrorCode: 20 });
			case 21:
			case 'Modal group violation':
				return new XError(XError.PARSE_ERROR, 'More than one g-code command from same modal group found in block.', { grblErrorCode: 21 });
			case 22:
			case 'Undefined feed rate':
				return new XError(XError.MACHINE_ERROR, 'Feed rate has not yet been set or is undefined.', { grblErrorCode: 22 });
			case 23:
			case 'Invalid gcode ID:23':
				return new XError(XError.MACHINE_ERROR, 'G-code command in block requires an integer value.', { grblErrorCode: 23 });
			case 24:
			case 'Invalid gcode ID:24':
				return new XError(XError.PARSE_ERROR, 'More than one g-code command that requires axis words found in block.', { grblErrorCode: 24 });
			case 25:
			case 'Invalid gcode ID:25':
				return new XError(XError.MACHINE_ERROR, 'Repeated g-code word found in block.', { grblErrorCode: 25 });
			case 26:
			case 'Invalid gcode ID:26':
				return new XError(XError.MACHINE_ERROR, 'No axis words found in block for g-code command or current modal state which requires them.', { grblErrorCode: 26 });
			case 27:
			case 'Invalid gcode ID:27':
				return new XError(XError.MACHINE_ERROR, 'Line number value is invalid.', { grblErrorCode: 27 });
			case 28:
			case 'Invalid gcode ID:28':
				return new XError(XError.MACHINE_ERROR, 'G-code command is missing a required value word.', { grblErrorCode: 28 });
			case 29:
			case 'Invalid gcode ID:29':
				return new XError(XError.MACHINE_ERROR, 'G59.x work coordinate systems are not supported.', { grblErrorCode: 29 });
			case 30:
			case 'Invalid gcode ID:30':
				return new XError(XError.MACHINE_ERROR, 'G53 only allowed with G0 and G1 motion modes.', { grblErrorCode: 30 });
			case 31:
			case 'Invalid gcode ID:31':
				return new XError(XError.MACHINE_ERROR, 'Axis words found in block when no command or current modal state uses them.', { grblErrorCode: 31 });
			case 32:
			case 'Invalid gcode ID:32':
				return new XError(XError.MACHINE_ERROR, 'G2 and G3 arcs require at least one in-plane axis word.', { grblErrorCode: 32 });
			case 33:
			case 'Invalid gcode ID:33':
				return new XError(XError.MACHINE_ERROR, 'Motion command target is invalid.', { grblErrorCode: 33 });
			case 34:
			case 'Invalid gcode ID:34':
				return new XError(XError.MACHINE_ERROR, 'Arc radius value is invalid.', { grblErrorCode: 34 });
			case 35:
			case 'Invalid gcode ID:35':
				return new XError(XError.MACHINE_ERROR, 'G2 and G3 arcs require at least one in-plane offset word.', { grblErrorCode: 35 });
			case 36:
			case 'Invalid gcode ID:36':
				return new XError(XError.MACHINE_ERROR, 'Unused value words found in block.', { grblErrorCode: 36 });
			case 37:
			case 'Invalid gcode ID:37':
				return new XError(XError.MACHINE_ERROR, 'G43.1 dynamic tool length offset is not assigned to configured tool length axis.', { grblErrorCode: 37 });
			case 38:
			case 'Invalid gcode ID:38':
				return new XError(XError.MACHINE_ERROR, 'Tool number greater than max supported value.', { grblErrorCode: 38 });
			default:
				return new XError(XError.MACHINE_ERROR, 'GRBL error: ' + ecode, { grblErrorCode: ecode });
		}
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
			this._commsHandleAckResponseReceived(this._responseCodeToError(matches[1]));
			return;
		}

		// Check for welcome message
		matches = this._regexWelcome.exec(line);
		if (matches) {
			this.grblDeviceVersion = matches[1];
			this.error = false;
			this.errorData = null;
			this.lastMessage = null;
			if (this._initializing && this._welcomeMessageWaiter) {
				// Complete initialization
				this._welcomeMessageWaiter.resolve();
				return;
			} else if (this._resetting) {
				// Ready again after reset
				this._cancelRunningOps(new XError(XError.MACHINE_ERROR, 'Machine reset'));
				this._commsReset();
				this._disableSending = false;
				this._resetting = false;
				this._initMachine()
					.then(() => {
						this._resetting = false;
						this.emit('initialized');
						if (this.ready) this.emit('ready');
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
			let err = this._alarmCodeToError(matches[1]);
			this.errorData = err;
			// Don't cancel ops or emit error on routine probe alarms
			if (err.code !== XError.PROBE_NOT_TRIPPED) {
				this._cancelRunningOps(err);
				if (!this._initializing) this.emit('error', err);
			}
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
			this.lastMessage = matches[1];
			this._handleReceivedMessage(matches[1], false);
			return;
		}

		// Check if it's parser state feedback
		matches = this._regexParserState.exec(line);
		if (!matches) matches = this._regexParserState09.exec(line);
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

		// Version data for 0.9
		matches = this._regexVersion09.exec(line);
		if (matches) {
			this._handleDeviceParameterUpdate('VER', matches[1]);
			return;
		}

		// Check if it's some other feedback value
		matches = this._regexFeedback.exec(line);
		if (matches) {
			this._handleReceivedMessage(matches[1], true);
			return;
		}

		// Unmatched line
		console.error('Received unknown line from grbl: ' + line);
	}

	_humanReadableMessage(msg) {
		switch(msg) {
			case "'$H'|'$X' to unlock":
				return 'Position lost; home machine or clear error';
			case 'Caution: Unlocked':
				return 'Caution: Error cleared';
			case 'Pgm End':
				return 'Program end';
			default:
				return msg;
		}
	}

	_handleReceivedMessage(str, unwrapped = false) {
		// suppress some messages during certain operations where the messages are handled automatically and
		// don't need to be reported to the user
		if (this._ignoreUnlockedMessage && str === 'Caution: Unlocked') return;
		if (this._ignoreUnlockPromptMessage && str === "'$H'|'$X' to unlock") return;
		this.emit('message', this._humanReadableMessage(str));
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

	_writeToSerial(strOrBuf) {
		if (!this.serial) return;
		this.serial.write(strOrBuf);
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
					this._writeToSerial('\x18');
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
			this._initializing = false;
			this.emit('connected');
			this.emit('initialized');
			if (this.ready) this.emit('ready');
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
		//this.debug('In _sendBlock(), queue: ' + this.sendQueue.map((e) => [ e.str, e.duration, e.timeExecuted ].join(',')).join(' | '));
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
		//this.debug('_commsCheckExecutedLoop()');
		if (this._checkExecutedLoopTimeout !== null) {
			// there's already a timeout running
			//this.debug('Check executed loop already running');
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
				//this.debug('_commsCheckExecutedLoop() shifting send queue');
				this._commsShiftSendQueue();
				shiftedAny = true;
			}
			if (shiftedAny) this._checkSendLoop();
		}
		// if there's something queued at the front of sendQueue, wait until then
		if (this.sendQueueIdxToReceive > 0 && this._checkExecutedLoopTimeout === null) {
			const minWait = 100;
			let twait = this.sendQueue[0].timeExecuted - mtime;
			if (twait < minWait) twait = minWait;
			//this.debug('_commsCheckExecutedLoop() scheduling another loop in ' + twait);
			this._checkExecutedLoopTimeout = setTimeout(() => {
				//this.debug('Retrying _commsCheckExecutedLoop');
				this._checkExecutedLoopTimeout = null;
				this._commsCheckExecutedLoop();
			}, twait);
		}
	}

	_commsShiftSendQueue() {
		//this.debug('_commsShiftSendQueue()');
		if (!this.sendQueue.length || !this.sendQueueIdxToReceive) return;
		let entry = this.sendQueue.shift();
		this.sendQueueIdxToSend--;
		this.sendQueueIdxToReceive--;
		if (entry.hooks) entry.hooks.triggerSync('executed', entry);
		if (this.sendQueue.length && this.sendQueueIdxToReceive) {
			this.lastLineExecutingTime = this._getCurrentMachineTime();
			//this.debug('_commsShiftSendQueue triggering executing hook: ' + this.sendQueue[0].str);
			if (this.sendQueue[0].hooks) this.sendQueue[0].hooks.triggerSync('executing', this.sendQueue[0]);
		}
		if (!this.sendQueue.length) this.emit('_sendQueueDrain');
	}

	_commsHandleAckResponseReceived(error = null) {
		//this.debug('_commsHandleAckResponseReceived');
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
					//this.debug('_commsHandleAckResponseReceived calling executing hook at head of sendQueue: ' + entry.str);
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
					//this.debug('_commsHandleAckResponseReceived calling executing hook; second case: ' + entry.str);
					entry.hooks.triggerSync('executing', entry);
					entry.hooks.triggerSync('executed', entry);
				}
				if (!this.sendQueue.length) this.emit('_sendQueueDrain');
			}
		} else {
			// Got an error on the request.  Splice it out of sendQueue, and call the error hook on the gcode line
			this.sendQueue.splice(this.sendQueueIdxToReceive, 1);
			this.sendQueueIdxToSend--; // need to adjust this for the splice
			if (!error.data) error.data = {};
			error.data.request = entry.str;

			if (entry.hooks) {
				entry.hooks.triggerSync('error', error);
			}

			const cancelEverythingOnError = true;
			if (cancelEverythingOnError) {
				this._cancelRunningOps(error);
			} else {
				if (!this.sendQueue.length) this.emit('_sendQueueDrain');
			}
			this.emit('message', error.message);
		}

		//this.debug('_commsHandleAckResponseReceived calling _commsCheckExecutedLoop');
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
			// reset held state and timer(s)
			if (this.held) {
				this.totalHeldMachineTime += new Date().getTime() - this.lastHoldStartTime;
				this.lastHoldStartTime = null;
				this.held = false;
			}

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

	sendExtendedAsciiCommand(code) {
		let buf = Buffer.from([ code ]);
		this._writeToSerial(buf);
		this.emit('sent', '<<' + code + '>>');
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

		matches = this._regexRstCommand.exec(cmd);
		if (matches) {
			// update all local state after a $RST
			this.send('$$');
			this.send('$#');
			this.send('$I');
			this.send('?');
		}
	}

	_updateStateFromGcode(gline) {
		//this.debug('_updateStateFromGcode: ' + gline.toString());
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
		if (gline.has('G10') && gline.has('L20') && gline.has('P')) {
			let csys = gline.get('P') - 1;
			statusUpdates['coordSysOffsets.' + csys] = [];
			for (let axisNum = 0; axisNum < this.axisLabels.length; axisNum++) {
				let axis = this.axisLabels[axisNum].toUpperCase();
				let val = 0;
				if (gline.has(axis)) val = gline.get(axis);
				statusUpdates['coordSysOffsets.' + csys][axisNum] = this.mpos[axisNum] - val;
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
			this.errorData = XError.isXError(err) ? err : new XError(XError.MACHINE_ERROR, '' + err);
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
		if (this.error) return Promise.reject(this.errorData || new XError(XError.MACHINE_ERROR, 'Error waiting for sync'));

		this.send('G4 P0.01'); // grbl won't ack this until its planner buffer is empty

		//if (this._isSynced()) return Promise.resolve();	
		//this.send('?');

		return new Promise((resolve, reject) => {
			const checkSyncHandler = () => {
				if (this.error) {
					reject(this.errorData || new XError(XError.MACHINE_ERROR, 'Error waiting for sync'));
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
			const okHandler = () => {
				// expedites syncing
				this.send('?');
			};
			const removeListeners = () => {
				this.removeListener('cancelRunningOps', checkSyncErrorHandler);
				this.removeListener('_sendQueueDrain', checkSyncHandler);
				this.removeListener('_sendingDisabled', checkSyncHandler);
				this.removeListener('receivedOk', okHandler);
			};
			this.on('cancelRunningOps', checkSyncErrorHandler);
			// events that can cause a sync: sr received, this.sendQueue drain, sending disabled
			this.on('statusReportReceived', checkSyncHandler);
			this.on('_sendQueueDrain', checkSyncHandler);
			this.on('_sendingDisabled', checkSyncHandler);
			this.on('receivedOk', okHandler);
		});
	}

	hold() {
		this.sendLine('!');
	}

	resume() {
		this.sendLine('~');
	}

	cancel() {
		// grbl doesn't have a queue wipe feature, so use a device reset and work around the issues with that.
		// The issues with this are:
		// 1) If we're currently moving, a reset will cause grbl to lose position.  To account for this, first execute
		//    a feed hold and wait for it to take effect.
		// 2) Even though grbl appears to correctly save position if reset during a feed hold, it still enters an alart
		//    state (position lost) after the reset.  To account for this, check for this state after the reset, and
		//    clear the alarm.
		// 3) On reset, parser state is lost, so save parser state prior to the reset and recover it afterwards, with
		//    the exception of spindle and coolant.  NOTE: This is currently DISABLED because resetting parser state
		//    may actually be expected on cancel.

		const doCancel = async() => {
			// Execute feed hold
			if (!this.held) this.hold();

			// Wait for status report to confirm feed hold
			await this._waitForEvent('statusReportReceived', () => this.held && this.currentStatusReport.machineState.toLowerCase() !== 'hold:1');

			// If on an older version of grbl that doesn't support the 'hold complete' substate, wait an additional delay
			if (this.currentStatusReport.machineState.toLowerCase() !== 'hold:0') {
				await pasync.setTimeout(500);
			}

			// Copy relevant parser state to restore later
			let restoreHomed = objtools.deepCopy(this.homed);
			let restoreState = {
				activeCoordSys: this.activeCoordSys,
				units: this.units,
				feed: this.feed,
				incremental: this.incremental,
				inverseFeed: this.inverseFeed
			};

			// Perform the reset (inside a try so we can make sure to restore the ignored messages)
			this._ignoreUnlockPromptMessage = true;
			try {
				this.reset();

				// Wait for the reset to complete.  Can't use _waitForEvent for this because _waitForEvent fails if
				// operations are cancelled during it, and a reset performs an operation cancel.
				await new Promise((resolve, reject) => {
					const readyHandler = () => {
						this.removeListener('initialized', readyHandler);
						resolve();
					};
					// use 'initialized' instead of 'ready' because ready isn't necessarily fired if resetting into an alarm state
					this.on('initialized', readyHandler);
				});
			} finally {
				this._ignoreUnlockPromptMessage = false;
			}

			// If alarmed due to a loss of position, assume the alarm is erroneous (since we did a feed hold before
			// the reset) and clear it.
			if (this.error && this.errorData && this.errorData.code === XError.MACHINE_ERROR && this.errorData.data && this.errorData.data.subcode === 'position_unknown') {
				this._ignoreUnlockedMessage = true;
				try {
					await this.request('$X');
				} finally {
					this._ignoreUnlockedMessage = false;
				}
			}

			// Restore parser state after reset.  Uses timeEstVM but substitutes our own state object
			this.homed = restoreHomed;
			//let restoreGcodes = this.timeEstVM.syncMachineToState({ vmState: restoreState });
			//for (let l of restoreGcodes) this.send(l);
		};

		doCancel().catch(() => {}); // ignore errors (errors in this process get reported in other ways)
	}

	reset() {
		if (!this.serial) return; // no reason to soft-reset GRBL without active connection
		if (!this._initializing && !this._resetting) {
			this.sendLine('\x18');
		}
	}

	clearError() {
		if (!this.serial) return;
		if (this.errorData && this.errorData.code === XError.SAFETY_INTERLOCK) {
			this.sendExtendedAsciiCommand(0x84);
		} else {
			this.send('$X');
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

		let [ tripPos, probeTripped ] = this.receivedDeviceParameters.PRB;
		if (!probeTripped) {
			this._ignoreUnlockedMessage = true;
			try {
				// Assume we're in an alarm state now and reset the alarm
				await this.request('$X');
				// Fetch a status report to ensure that status is updated properly
				await this.fetchUpdateStatusReport();
			} finally {
				this._ignoreUnlockedMessage = false;
			}
			this.timeEstVM.syncStateToMachine({ include: [ 'mpos' ], controller: this });
			throw new XError(XError.PROBE_NOT_TRIPPED, 'Probe was not tripped during probing');
		}
		
		// If the probe was successful, move back to the position the probe tripped
		await this.move(tripPos);

		// Sync the time estimation vm position to the new pos after probing
		this.timeEstVM.syncStateToMachine({ include: [ 'mpos' ], controller: this });

		return tripPos;
	}

	getStatus() {
		let o = super.getStatus();
		o.comms = {
			sendQueueLength: this.sendQueue.length,
			sendQueueIdxToSend: this.sendQueueIdxToSend,
			sendQueueIdxToReceive: this.sendQueueIdxToReceive
		};
		return o;
	}
}


module.exports = GRBLController;

