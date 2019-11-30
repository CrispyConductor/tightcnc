const EventEmitter = require('events');
const XError = require('xerror');

class Controller extends EventEmitter {

	/**
	 * Base class for CNC controllers.  Each subclass corresponds to a type of CNC controller and manages the connection
	 * to that controller.
	 *
	 * @class Controller
	 * @constructor
	 * @param {Object} config - Controller-specific configuration blob
	 */
	constructor(config) {
		// Configuration for the controller.  The format of this is entirely dependent on the subclass.
		this.config = config;
		// See resetState() for property definitions.
		this.resetState();
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
		// Current coordinates in machine position for each of the axes
		this.mpos = [ 0, 0, 0 ];
		// Currently active coordinate system.  0 corresponds to G54, 1 to G55, etc.
		this.activeCoordSys = 0;
		// For each coordinate system, the offsets for that system to the machine coordinates
		this.coordSysOffsets = [ [ 0, 0, 0 ] ];
		// Configured offset (set by G92)
		this.offset = [ 0, 0, 0 ];
		// Whether the current G92 offset is enabled
		this.offsetEnabled = false;
		// Stored machine positions; 0 corresponds to G28, 1 corresponds to G30
		this.storedPositions = [ [ 0, 0, 0 ] ];
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
		// If a program is currently running
		this.programRunning = false;
		// If the machine is currently moving
		this.moving = false;
		// If coolant is running.  Can also be 1 or 2 for mist or flood coolant
		this.coolant = false;
		// If spindle is running
		this.spindle = false;
		// Last line number executed
		this.line = 0;
		// null if there's no machine error, or some value describing the error state
		this.error = null;
	}

	/**
	 * Initialize and connect to CNC machine.  Should update machine state properties as much as is possible.
	 *
	 * @method init
	 * @return {Promise}
	 */
	init() {}

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
	 * Streams a file to the controller, as in send().  Should only resolve once whole file has been executed.
	 *
	 * @method sendFile
	 * @param {String} filename - Filename to send.
	 * @return {Promise} - Resolves when whole file has been sent, and movements processed.
	 */
	sendFile(filename) {
		// TODO
	}

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
	cancel() {
		// TODO: handle cancelling sendFile, other stuff?
	}

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
	 * @param {Number[]} pos - Position to move to.  Array elements may be null to not move on that axis.
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
	 * Probe toward position.  Resolve when probe trips.  Error if probe reaches position without tripping.
	 *
	 * @method probe
	 * @param {Number[]} pos
	 * @param {Number} [feed]
	 * @return {Promise{pos}}
	 */
	probe(pos, feed = null) {}

	_updateStateFromGcode(line) {
	}

}

// Error code for serial port communication errors
XError.registerErrorCode('comm_error', { 'message': 'Error communicating with controller.' });
// Error code when probe doesn't trip
XError.registerErrorCode('probe_end', { 'message': 'Probe reached end position without tripping.' });
// Error code when failing to parse serial message
XError.registerErrorCode('parse_error', { 'message': 'Error parsing' });

module.exports = Controller;

