const objtools = require('objtools');
const XError = require('xerror');
const zstreams = require('zstreams');
const GcodeProcessor = require('../../lib/gcode-processor');
const fs = require('fs');
const path = require('path');

class JobManager {

	constructor(tightcnc) {
		this.tightcnc = tightcnc;
		this.currentJob = null;
	}

	initialize() {
	}

	getStatus() {
		if (!this.currentJob) return null;
		let job = this.currentJob;

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
		if (finalVMStatus && finalVMStatus.updateTime) {
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
			state: this.currentJob.state,
			jobOptions: this.currentJob.jobOptions,
			dryRunResults: this.currentJob.dryRunResults,
			startTime: this.currentJob.startTime,
			error: this.currentJob.state === 'error' ? this.currentJob.error.toString() : null,
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
		this.currentJob = {
			state: 'initializing',
			jobOptions: origJobOptions,
			dryRunResults: dryRunResults,
			startTime: new Date().toISOString()
		};
		job = this.currentJob;

		// Wait for the controller to stop moving
		await this.tightcnc.controller.waitSync();

		// Note that if the following few lines have any await's in between them, it could result
		// in certain errors from gcode processors breaking things, since errors are handled through
		// Controller#sendStream().

		// Build the processor chain
		let source = this.tightcnc.getGcodeSourceStream({
			filename: jobOptions.filename,
			gcodeProcessors: jobOptions.gcodeProcessors,
			rawStrings: jobOptions.rawFile
		});
		job.sourceStream = source;
		// Pipe it to the controller, asynchronously
		this.tightcnc.controller.sendStream(source)
			.then(() => {
				job.state = 'complete';
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
			});

		// Wait until the processorChainReady event (or chainerror event) fires on source (indicating any preprocessing is done)
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

		return this.getStatus();
	}

	async dryRunJob(jobOptions, outputFile = null) {
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
		// Do dry run to get overall stats
		let source = this.tightcnc.getGcodeSourceStream({
			filename: jobOptions.filename,
			gcodeProcessors: jobOptions.gcodeProcessors,
			rawStrings: jobOptions.rawFile,
			dryRun: true
		});
		let origSource = source;
		source = source.through((gline) => {
			// call hooks on each line (since there's no real controller to do it)
			GcodeProcessor.callLineHooks(gline);
			return gline;
		});
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
		// Get the job stats
		let gpcStatuses = {};
		let gpc = origSource.gcodeProcessorChainById || {};
		for (let key in gpc) {
			let s = gpc[key].getStatus();
			if (s) {
				gpcStatuses[key] = s;
			}
		}
		return {
			jobOptions: origJobOptions,
			stats: this._mainJobStats(gpcStatuses),
			gcodeProcessors: gpcStatuses
		};
	}
}

module.exports = JobManager;

