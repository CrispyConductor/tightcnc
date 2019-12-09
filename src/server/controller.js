const EventEmitter = require('events');
const XError = require('xerror');
const fs = require('fs');

class Controller extends EventEmitter {

	/**
	 * Base class for CNC controllers.  Each subclass corresponds to a type of CNC controller and manages the connection
	 * to that controller.
	 *
	 * Events that should be emitted:
	 *   - statusUpdate - When the status variables are updated.  No parameters.
	 *   - ready - When the connection is ready for use.
	 *   - sent - When raw data is sent, argument should be raw data string. (newline may be absent)
	 *   - received - When raw data is received, argument should be raw data string. (newline may be absent)
	 *
	 * @class Controller
	 * @constructor
	 * @param {Object} config - Controller-specific configuration blob
	 */
	constructor(config) {
		super();
		// Configuration for the controller.  The format of this is entirely dependent on the subclass.
		this.config = config;
		// See resetState() for property definitions.
		this.resetState();
	}

	/**
	 * Gets current offsets from machine coordinate system.
	 *
	 * @method getCoordOffsets
	 * @return {Number[]}
	 */
	getCoordOffsets() {
		let offsets = [];
		for (let i = 0; i < this.axisLabels.length; i++) offsets[i] = 0;
		if (typeof this.activeCoordSys === 'number' && this.activeCoordSys >= 0) {
			// Not machine coordinates; set offsets from this coord system
			let csysOffsets = this.coordSysOffsets[this.activeCoordSys];
			if (csysOffsets) {
				for (let i = 0; i < csysOffsets.length; i++) {
					offsets[i] += csysOffsets[i];
				}
			}
		}
		if (this.offsetEnabled && this.offset) {
			for (let i = 0; i < this.offset.length; i++) {
				offsets[i] += this.offset[i];
			}
		}
		return offsets;
	}

	/**
	 * Gets the position in current coordinate system, with offset.
	 *
	 * @method getPos
	 * @return {Number[]}
	 */
	getPos() {
		let off = this.getCoordOffsets();
		let r = [];
		for (let i = 0; i < this.mpos.length; i++) {
			let o = off[i] || 0;
			r.push(this.mpos[i] - o);
		}
		return r;
	}

	/**
	 * Resets state properties to defaults.
	 *
	 * @method resetState
	 */
	resetState() {
		// Whether or not the machine is connected and ready to accept input
		this.ready = false;
		// Labels for each of the axes
		this.axisLabels = [ 'x', 'y', 'z' ];
		// Which axes are actually used
		this.usedAxes = [ true, true, true ];
		// Which axes can be automatically homed
		this.homableAxes = [ true, true, true ];
		// Current coordinates in machine position for each of the axes
		this.mpos = [ 0, 0, 0 ];
		// Currently active coordinate system.  0 corresponds to G54, 1 to G55, etc.  null means G53 machine coordinates.
		this.activeCoordSys = 0;
		// For each coordinate system, the offsets for that system to the machine coordinates
		this.coordSysOffsets = [ [ 0, 0, 0 ] ];
		// Configured offset (set by G92)
		this.offset = [ 0, 0, 0 ];
		// Whether the current G92 offset is enabled
		this.offsetEnabled = false;
		// Stored machine positions; 0 corresponds to G28, 1 corresponds to G30
		this.storedPositions = [ [ 0, 0, 0 ], [ 0, 0, 0 ] ];
		// Whether machine is homed, for each axis
		this.homed = [ false, false, false ];
		// If the machine is currently paused / feed hold
		this.paused = false;
		// Current units configured for machine; 'mm' or 'in'
		this.units = 'mm';
		// Current feed rate for machine
		this.feed = 0;
		// Whether machine is currently in incremental mode
		this.incremental = false;
		// If the machine is currently moving
		this.moving = false;
		// If coolant is running.  Can also be 1 or 2 for mist or flood coolant, or 3 for both.
		this.coolant = false;
		// If spindle is running
		this.spindle = false;
		// Last line number executed
		this.line = 0;
		// true if the machine is in an error state
		this.error = false;
		this.errorData = null;
		// true if a program is running
		this.programRunning = false;
		// 1 for CW, -1 for CCW
		this.spindleDirection = 1;
		// Speed of spindle, if known
		this.spindleSpeed = null;
		// True for inverse feedrate mode
		this.inverseFeed = false;
	}

	/**
	 * Initialize and connect to CNC machine.  Should update machine state properties as much as is possible.
	 *
	 * @method initConnection
	 * @param {Boolean} retry - Whether to continue retrying to connect on error
	 */
	initConnection(retry = true) {}

	/**
	 * Sends a (gcode) line to the controller.  Should parse the line to update machine state if necessary.
	 *
	 * @method send
	 * @param {String} line - Line to send.
	 */
	send(line) {}

	/**
	 * Sends a line to the controller.  Resolves a promise once the line has been processed.  (Not necessarily if action
	 * is completed - just processed.  So should not be used to check if movement is completed.
	 *
	 * @method sendWait
	 * @param {String} line
	 * @return {Promise}
	 */
	sendWait(line) {}

	/**
	 * Streams a file or other string to the controller, as in send().  Should only resolve once whole stream has been executed.
	 *
	 * @method sendStream
	 * @param {ReadableString} stream - Readable character stream
	 * @return {Promise} - Resolves when whole stream has been sent, and movements processed.
	 */
	sendStream(stream) {}

	sendFile(filename) {
		return this.sendStream(fs.createReadStream(filename));
	}

	/**
	 * Returns a promise that resolves when the machine state properties on this class have been fully synchronized with
	 * the machine.  Generally this means that all movement has stopped, all sent lines have been processed, and there's nothing
	 * left in the queue.  Calling this function may temporarily pause the send queue.  After the returned promise resolves,
	 * the state variables are only guaranteed to be in sync until the next send queue entry is sent (which might be right away).
	 * To guarantee proper operation, no other commands should be sent until after this function resolves.
	 *
	 * @method waitSync
	 * @return {Promise}
	 */
	waitSync() {}

	/**
	 * Pauses machine / feed hold.
	 *
	 * @method pause
	 */
	hold() {}

	/**
	 * Resumes paused machine.
	 *
	 * @method resume
	 */
	resume() {}

	/**
	 * Cancels any current operations and flushes queue.  If machine is paused, unpauses.
	 *
	 * @method cancel
	 */
	cancel() {}

	/**
	 * Resets machine.
	 *
	 * @method reset
	 */
	reset() {}

	/**
	 * Move by inc in direction of axis.  If this is called multiple times before a previous move is completed, extra invocations
	 * should be ignored.  This is used for real-time control of the machine with an interface.
	 *
	 * @method realTimeMove
	 * @param {Number} axis - Axis number.  0=x, 1=y, etc.
	 * @param {Number} inc - Increment to move axis by.
	 */
	realTimeMove(axis, inc) {}

	/**
	 * Moves machine linearly to point, resolving promise when movement is complete and machine is stopped.
	 * Should not be called simultaneously with any other functions.  Promise should error if a cancel() is
	 * executed before the move completes.  (G0/G1)
	 *
	 * @method move
	 * @param {Number[]} pos - Position to move to.  Array elements may be null/undefined to not move on that axis.
	 * @param {Number} [feed] - Optional feed rate to move at.
	 * @return {Promise} - Resolve when move is complete and machine is stopped.
	 */
	move(pos, feed = null) {}

	/**
	 * Home machine. (G28.2)
	 *
	 * @method home
	 * @param {Boolean[]} axes - true for each axis to home; false for others
	 * @return {Promise} - Resolves when homing is complete.
	 */
	home(axes) {}

	/**
	 * Probe toward position.  Resolve when probe trips.  Error if probe reaches position without tripping.  This should return
	 * the position that the probe tripped at, and also ensure that the machine is positioned at that location.
	 *
	 * @method probe
	 * @param {Number[]} pos
	 * @param {Number} [feed]
	 * @return {Promise{pos}}
	 */
	probe(pos, feed = null) {}

	/**
	 * Return an object containing controller status.  Controller classes may override this, but should make an effort
	 * to conform as much as possible to the format of this status object.
	 *
	 * @method getStatus
	 * @return {Object}
	 */
	getStatus() {
		let c = this;
		return {
			ready: c.ready,
			axisLabels: c.axisLabels,
			usedAxes: c.usedAxes,
			mpos: c.mpos,
			pos: c.getPos(),
			mposOffset: c.getCoordOffsets(),
			activeCoordSys: c.activeCoordSys,
			offset: c.offset,
			offsetEnabled: c.offsetEnabled,
			storedPositions: c.storedPositions,
			homed: c.homed,
			paused: c.paused,
			units: c.units,
			feed: c.feed,
			incremental: c.incremental,
			moving: c.moving,
			coolant: c.coolant,
			spindle: c.spindle,
			line: c.line,
			error: c.error,
			errorData: c.errorData,
			programRunning: c.programRunning
		};
	}

	listUsedAxisNumbers() {
		let ret = [];
		for (let axisNum = 0; axisNum < this.usedAxes.length; axisNum++) {
			if (this.usedAxes[axisNum]) ret.push(axisNum);
		}
		return ret;
	}

	listUsedAxisLabels() {
		let ret = [];
		for (let axisNum = 0; axisNum < this.usedAxes.length; axisNum++) {
			if (this.usedAxes[axisNum]) {
				ret.push(this.axisLabels[axisNum]);
			}
		}
		return ret;
	}

}

// Error code for serial port communication errors
XError.registerErrorCode('comm_error', { message: 'Error communicating with controller.' });
// Error code when probe doesn't trip
XError.registerErrorCode('probe_end', { message: 'Probe reached end position without tripping.' });
// Error code when failing to parse serial message
XError.registerErrorCode('parse_error', { message: 'Error parsing' });
// Error code for generic error report from the machine
XError.registerErrorCode('machine_error', { message: 'Machine error' });
// When an operation is cancelled
XError.registerErrorCode('cancelled', { message: 'Cancelled' });
// Error when a probe is not tripped
XError.registerErrorCode('probe_not_tripped', { message: 'Probe was not tripped' });

module.exports = Controller;

