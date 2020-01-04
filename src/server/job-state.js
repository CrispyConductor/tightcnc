const EventEmitter = require('events');
const objtools = require('objtools');

/**
 * This class tracks the state of a running job or dry run.  It's mostly just a collection of properties
 * managed by JobManager.  It can also emit the events 'start', 'complete' and 'error' (also managed by JobManager).
 *
 * @class JobState
 */
class JobState extends EventEmitter {

	constructor(props = {}) {
		super();
		this.state = 'initializing';
		this.startTime = new Date().toISOString();
		this._hasFinished = false;
		// this is a list of values that the job is currently "waiting" for.  these waits are managed by gcode processors, and must be
		// added and removed by the gcode processor.  the values themselves don't mean anything.  as long as there's at least one
		// entry in this wait list, the job status is returned as "waiting"
		this.waitList = [];
		for (let key in props) {
			this[key] = props[key];
		}
		// add a handler for 'error' so the default handler (exit program) doesn't happen
		this.on('error', () => {});
	}

	emitJobStart() {
		if (this._hasFinished) return;
		this.emit('start');
	}

	emitJobError(err) {
		if (this._hasFinished) return;
		this._hasFinished = true;
		this.emit('error', err);
	}

	emitJobComplete() {
		if (this._hasFinished) return;
		this._hasFinished = true;
		this.emit('complete');
	}

	addWait(val) {
		this.waitList.push(val);
	}

	removeWait(val) {
		this.waitList = this.waitList.filter((a) => !objtools.deepEquals(a, val));
	}

}

module.exports = JobState;


