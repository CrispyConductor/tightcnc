const objtools = require('objtools');
const XError = require('xerror');
const zstreams = require('zstreams');
const GcodeProcessor = require('../../lib/gcode-processor');
const fs = require('fs');
const path = require('path');

class JobStatusGcodeProcessor extends GcodeProcessor {
	constructor(options, statusCallback) {
		super(options, 'jobStatus', false);
		this.jobStatusCallback = statusCallback;
	}
	copyProcessor() {
		let r = super.copyProcessor();
		r.jobStatusCallback = null;
	}
	processGcode(gline) {
		if (this.jobStatusCallback) {
			this.jobStatusCallback(gline.gcodeProcessors);
		}
		return gline;
	}
}

class JobManager {

	constructor(tightcnc) {
		this.tightcnc = tightcnc;
		this.currentJob = null;
	}

	initialize() {
	}

	getStatus() {
		if (!this.currentJob) return null;
		return {
			state: this.currentJob.state,
			jobOptions: this.currentJob.jobOptions,
			dryRunResults: this.currentJob.dryRunResults,
			startTime: this.currentJob.startTime,
			error: this.currentJob.error,
			gcodeProcessors: this.currentJob.gcodeProcessors,
			stats: this.currentJob.stats,
			progress: this.currentJob.progress
		};
	}

	_mainJobStats(gcodeProcessorStats) {
		if (!gcodeProcessorStats || !gcodeProcessorStats['final-job-vm']) return null;
		return {
			time: gcodeProcessorStats['final-job-vm'].totalTime,
			line: gcodeProcessorStats['final-job-vm'].line,
			lineCount: gcodeProcessorStats['final-job-vm'].lineCounter
		};
	}

	/**
	 * Start running a job on the machine.
	 *
	 * @method startJob
	 * @param {Object} jobOptions
	 *   @param {String} jobOptions.filename - The input gcode file for the job.
	 *   @param {Object[]} jobOptions.gcodeProcessors - The set of gcode processors to apply, in order, along with
	 *     options for each.
	 *     @param {String} options.gcodeProcessors.#.name - Name of gcode processor.
	 *     @param {Object} options.gcodeProcessors.#.options - Additional options to pass to gcode processor constructor.
	 *   @param {Boolean} [options.rawFile=false] - If true, pass the file unaltered to the controller, without running
	 *     any gcode processors.  (Will disable status reports)
	 */
	async startJob(jobOptions) {
		let job = null;

		// First do a dry run of the job to fetch overall stats
		let dryRunResults = await this.dryRunJob(jobOptions);

		// Set up the gcode processors for this job
		let origJobOptions = jobOptions;
		jobOptions = objtools.deepCopy(jobOptions);
		jobOptions.filename = path.resolve(this.tightcnc.config.dataDir, jobOptions.filename);
		if (jobOptions.rawFile) {
			delete jobOptions.gcodeProcessors;
		} else {
			// add default gcode vm processor to enable basic status updates automatically
			if (!jobOptions.gcodeProcessors) jobOptions.gcodeProcessors = [];
			jobOptions.gcodeProcessors.push({
				name: 'gcodevm',
				options: {
					id: 'final-job-vm'
				}
			});
			jobOptions.gcodeProcessors.push({
				name: 'jobStatus',
				options: {
					id: 'job-status-reporter'
				},
				inst: new JobStatusGcodeProcessor({ tightcnc: this.tightcnc }, (gps) => {
					if (gps && job) {
						job.gcodeProcessors = gps;
						job.stats = this._mainJobStats(gps);
						job.stats.predictedTime = job.stats.time;
						let curTime = new Date();
						job.stats.updateTime = curTime.toISOString();
						job.stats.time = (curTime.getTime() - new Date(job.startTime).getTime()) / 1000;
						// create job progress object
						if (job.stats && job.dryRunResults && job.dryRunResults.stats && job.dryRunResults.stats.time) {
							let estTotalTime = job.dryRunResults.stats.time;
							if (job.stats.lineCount >= 300) { // don't adjust based on current time unless enough lines have been processed to compensate for stream buffering
								estTotalTime *= (curTime.getTime() - new Date(job.startTime).getTime()) / 1000 / job.stats.predictedTime;
							}
							job.progress = {
								timeRunning: job.stats.time,
								estTotalTime: estTotalTime,
								estTimeRemaining: Math.max(estTotalTime - job.stats.time, 0),
								percentComplete: Math.min(job.stats.time / (estTotalTime || 1) * 100, 100)
							};
						}
					}
				})
			});
		}
		// Check to ensure current job isn't running and that the controller is ready
		if (this.currentJob && this.currentJob.state !== 'complete' && this.currentJob.state !== 'cancelled' && this.currentJob.state !== 'error') {
			throw new XError(XError.INTERNAL_ERROR, 'Cannot start job with another job running.');
		}
		if (!this.tightcnc.controller.ready) {
			throw new XError(XError.INTERNAL_ERROR, 'Controller not ready.');
		}
		// Create the current job object
		this.currentJob = {
			state: 'initializing',
			jobOptions: origJobOptions,
			dryRunResults: dryRunResults,
			startTime: new Date().toISOString()
		};
		job = this.currentJob;
		// Build the processor chain
		let source = await this.tightcnc.getGcodeSourceStream({
			filename: jobOptions.filename,
			gcodeProcessors: jobOptions.gcodeProcessors
		});
		job.sourceStream = source;
		// Wait for the controller to stop moving
		await this.tightcnc.controller.waitSync();
		// Pipe it to the controller, asynchronously
		job.state = 'running';
		this.tightcnc.controller.sendStream(source)
			.then(() => {
				job.state = 'complete';
			})
			.catch((err) => {
				if (err.code === XError.CANCELLED) {
					job.state = 'cancelled';
				} else {
					job.state = 'error';
					job.error = err.toObject ? err.toObject() : err;
				}
			});
		return this.getStatus();
	}

	async dryRunJob(jobOptions, outputFile = null) {
		let origJobOptions = jobOptions;
		jobOptions = objtools.deepCopy(jobOptions);
		jobOptions.filename = path.resolve(this.tightcnc.config.dataDir, jobOptions.filename);
		if (outputFile) outputFile = path.resolve(this.tightcnc.config.dataDir, outputFile);
		let gcodeProcessorStatus = {};
		if (jobOptions.rawFile) {
			delete jobOptions.gcodeProcessors;
		} else {
			// add default gcode vm processor to enable basic status updates automatically
			if (!jobOptions.gcodeProcessors) jobOptions.gcodeProcessors = [];
			jobOptions.gcodeProcessors.push({
				name: 'gcodevm',
				options: {
					id: 'final-job-vm'
				}
			});
			jobOptions.gcodeProcessors.push({
				name: 'jobStatus',
				options: {
					id: 'job-status-reporter'
				},
				inst: new JobStatusGcodeProcessor({ tightcnc: this.tightcnc }, (gps) => {
					if (gps) gcodeProcessorStatus = gps;
				})
			});
		}
		// Do dry run to get overall stats
		let source = await this.tightcnc.getGcodeSourceStream({
			filename: jobOptions.filename,
			gcodeProcessors: jobOptions.gcodeProcessors
		});
		if (outputFile) {
			await source.intoFile(outputFile);
		} else {
			await source.pipe(new zstreams.BlackholeStream({ objectMode: false })).intoPromise();
		}
		// Get the job stats
		let mainJobStats = this._mainJobStats(gcodeProcessorStatus);
		return {
			jobOptions: origJobOptions,
			stats: mainJobStats,
			gcodeProcessors: gcodeProcessorStatus
		};
	}
}

module.exports = JobManager;

