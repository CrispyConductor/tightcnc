const EventEmitter = require('events');

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

}

module.exports = JobState;


