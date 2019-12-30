const objtools = require('objtools');
const XError = require('xerror');
const zstreams = require('zstreams');
const GcodeProcessor = require('../../lib/gcode-processor');
const fs = require('fs');
const path = require('path');
const JobState = require('./job-state');

class JobManager {

	constructor(tightcnc) {
		this.tightcnc = tightcnc;
		this.currentJob = null;
	}

	initialize() {
	}

	getStatus(job) {
		if (!job) job = this.currentJob;
		if (!job) return null;

		// Fetch the status from each gcode processor
		let gcodeProcessorStatuses = undefined;
		if (job.gcodeProcessors) {
			gcodeProcessorStatuses = {};
			for (let key in job.gcodeProcessors) {
				let s = job.gcodeProcessors[key].getStatus();
				if (s) {
					gcodeProcessorStatuses[key] = s;
				}
			}
		}

		// Calculate main stats and progress
		let progress = undefined;
		let stats = this._mainJobStats(gcodeProcessorStatuses);
		stats.predictedTime = stats.time;
		let finalVMStatus = gcodeProcessorStatuses && gcodeProcessorStatuses['final-job-vm'];
		if (finalVMStatus && finalVMStatus.updateTime && !job.dryRun) {
			let curTime = new Date(finalVMStatus.updateTime);
			stats.updateTime = curTime.toISOString();
			stats.time = (curTime.getTime() - new Date(job.startTime).getTime()) / 1000;
			// create job progress object
			if (job.dryRunResults && job.dryRunResults.stats && job.dryRunResults.stats.time) {
				let estTotalTime = job.dryRunResults.stats.time;
				if (stats.lineCount >= 300) { // don't adjust based on current time unless enough lines have been processed to compensate for stream buffering
					estTotalTime *= (curTime.getTime() - new Date(job.startTime).getTime()) / 1000 / stats.predictedTime;
				}
				progress = {
					timeRunning: stats.time,
					estTotalTime: estTotalTime,
					estTimeRemaining: Math.max(estTotalTime - stats.time, 0),
					percentComplete: Math.min(stats.time / (estTotalTime || 1) * 100, 100)
				};
			}
		}

		// Return status
		return {
			state: job.state,
			jobOptions: job.jobOptions,
			dryRunResults: job.dryRunResults,
			startTime: job.startTime,
			error: job.state === 'error' ? job.error.toString() : null,
			gcodeProcessors: gcodeProcessorStatuses,
			stats: stats,
			progress: progress
		};
	}

	_mainJobStats(gcodeProcessorStats) {
		if (!gcodeProcessorStats || !gcodeProcessorStats['final-job-vm']) return { time: 0, line: 0, lineCount: 0 };
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
		this.tightcnc.debug('Begin startJob');

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
					id: 'final-job-vm',
					updateOnHook: 'executed'
				}
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
		this.currentJob = new JobState({
			state: 'initializing',
			jobOptions: origJobOptions,
			dryRunResults: dryRunResults,
			startTime: new Date().toISOString()
		});
		job = this.currentJob;

		// Wait for the controller to stop moving
		this.tightcnc.debug('startJob waitSync');
		await this.tightcnc.controller.waitSync();

		// Note that if the following few lines have any await's in between them, it could result
		// in certain errors from gcode processors breaking things, since errors are handled through
		// Controller#sendStream().

		// Build the processor chain
		this.tightcnc.debug('startJob getGcodeSourceStream');
		let source = this.tightcnc.getGcodeSourceStream({
			filename: jobOptions.filename,
			gcodeProcessors: jobOptions.gcodeProcessors,
			rawStrings: jobOptions.rawFile,
			job: job
		});
		job.sourceStream = source;

		job.emitJobStart();

		// Pipe it to the controller, asynchronously
		this.tightcnc.debug('startJob pipe stream');
		this.tightcnc.controller.sendStream(source)
			.then(() => {
				job.state = 'complete';
				job.emitJobComplete();
			})
			.catch((err) => {
				if (err.code === XError.CANCELLED) {
					job.state = 'cancelled';
				} else {
					job.state = 'error';
					job.error = err;
					console.error('Job error: ' + err);
					console.error(err.stack);
				}
				job.emitJobError(err);
			});

		// Wait until the processorChainReady event (or chainerror event) fires on source (indicating any preprocessing is done)
		this.tightcnc.debug('startJob wait for processorChainReady');
		await new Promise((resolve, reject) => {
			let finished = false;
			source.on('processorChainReady', (_chain, chainById) => {
				if (finished) return;
				finished = true;
				job.gcodeProcessors = chainById;
				job.startTime = new Date().toISOString();
				resolve();
			});
			source.on('chainerror', (err) => {
				if (finished) return;
				finished = true;
				job.state = 'error';
				job.error = err;
				reject(err);
			});
		});

		job.state = 'running';

		this.tightcnc.debug('End startJob');

		return this.getStatus(job);
	}

	async dryRunJob(jobOptions, outputFile = null) {
		this.tightcnc.debug('Begin dryRunJob');
		let origJobOptions = jobOptions;
		jobOptions = objtools.deepCopy(jobOptions);
		jobOptions.filename = path.resolve(this.tightcnc.config.dataDir, jobOptions.filename);
		if (outputFile) outputFile = path.resolve(this.tightcnc.config.dataDir, outputFile);
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
		}

		let job = new JobState({
			state: 'initializing',
			jobOptions: origJobOptions,
			startTime: new Date().toISOString(),
			dryRun: true
		});

		// Do dry run to get overall stats
		this.tightcnc.debug('Dry run getGcodeSourceStream');
		let source = this.tightcnc.getGcodeSourceStream({
			filename: jobOptions.filename,
			gcodeProcessors: jobOptions.gcodeProcessors,
			rawStrings: jobOptions.rawFile,
			dryRun: true,
			job: job
		});
		let origSource = source;
		source = source.through((gline) => {
			// call hooks on each line (since there's no real controller to do it)
			GcodeProcessor.callLineHooks(gline);
			return gline;
		});

		job.sourceStream = source;
		job.state = 'running';

		origSource.on('processorChainReady', (_chain, chainById) => {
			job.gcodeProcessors = chainById;
		});

		this.tightcnc.debug('Dry run stream');
		if (outputFile) {
			await source
				.throughData((chunk) => {
					if (typeof chunk === 'string') return chunk + '\n';
					else return chunk.toString() + '\n';
				})
				.intoFile(outputFile);
		} else {
			await source.pipe(new zstreams.BlackholeStream({ objectMode: true })).intoPromise();
		}

		job.state = 'complete';
		if (!job.gcodeProcessors) job.gcodeProcessors = origSource.gcodeProcessorChainById || {};

		// Get the job stats
		this.tightcnc.debug('Dry run get stats');
		/*let gpcStatuses = {};
		let gpc = origSource.gcodeProcessorChainById || {};
		for (let key in gpc) {
			let s = gpc[key].getStatus();
			if (s) {
				gpcStatuses[key] = s;
			}
		}*/
		let ret = this.getStatus(job);

		this.tightcnc.debug('End dryRunJob');
		/*return {
			jobOptions: origJobOptions,
			stats: this._mainJobStats(gpcStatuses),
			gcodeProcessors: gpcStatuses
		};*/
		return ret;
	}
}

module.exports = JobManager;

