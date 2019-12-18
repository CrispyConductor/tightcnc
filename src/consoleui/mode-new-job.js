const ConsoleUIMode = require('./consoleui-mode');
const blessed = require('blessed');
const XError = require('xerror');
const objtools = require('objtools');
const fs = require('fs');
const path = require('path');

class ModeNewJob extends ConsoleUIMode {

	constructor(consoleui) {
		super(consoleui);
		this.jobFilename = null;
		this.jobOptionInstances = {};
		this.dryRunResults = null;
	}

	updateJobInfoText() {
		let jobInfoStr = '';
		if (this.jobFilename) jobInfoStr += 'File: ' + this.jobFilename + '\n';
		
		for (let jobOptionName in this.jobOptionInstances) {
			let inst = this.jobOptionInstances[jobOptionName];
			let optionStr = inst.getDisplayString();
			if (optionStr) {
				jobInfoStr += '\n' + optionStr.trim();
			}
		}

		if (this.dryRunResults && this.dryRunResults.stats && this.dryRunResults.stats.lineCount) {
			jobInfoStr += '\n\n{bold}Dry Run Results{/bold}\n';
			jobInfoStr += 'Line count: ' + this.dryRunResults.stats.lineCount + '\n';
			let timeHours = Math.floor(this.dryRunResults.stats.time / 3600);
			let timeMinutes = Math.floor((this.dryRunResults.stats.time - timeHours * 3600) / 60);
			if (timeMinutes < 10) timeMinutes = '0' + timeMinutes;
			jobInfoStr += 'Est. Time: ' + timeHours + ':' + timeMinutes + '\n';
			let bounds = objtools.getPath(this.dryRunResults, 'gcodeProcessors.final-job-vm.bounds');
			if (bounds) {
				jobInfoStr += 'Bounds: ' + this.consoleui.pointToStr(bounds[0]) + ' to ' + this.consoleui.pointToStr(bounds[1]) + '\n';
			}
		}

		jobInfoStr = jobInfoStr.trim();
		if (!jobInfoStr) {
			jobInfoStr = '{bold}New Job{/bold}';
		} else {
			jobInfoStr = '{bold}New Job Info:{/bold}\n' + jobInfoStr;
		}

		this.jobInfoBox.setContent(jobInfoStr);
		this.consoleui.render();
	}

	selectJobFile() {
		this.consoleui.showWaitingBox();
		this.consoleui.client.op('listFiles', {})
			.then((files) => {
				this.consoleui.hideWaitingBox();
				files = files.filter((f) => f.type === 'gcode').map((f) => f.name);
				let fileListBox = blessed.list({
					style: {
						selected: {
							inverse: true
						},
						item: {
							inverse: false
						}
					},
					keys: true,
					items: files,
					width: '50%',
					height: '50%',
					border: {
						type: 'line'
					},
					top: 'center',
					left: 'center'
				});
				this.box.append(fileListBox);
				fileListBox.focus();
				fileListBox.once('select', () => {
					let selectedFile = files[fileListBox.selected];
					this.jobFilename = selectedFile;
					this.dryRunResults = null;
					this.box.remove(fileListBox);
					this.updateJobInfoText();
				});
				fileListBox.once('cancel', () => {
					this.box.remove(fileListBox);
					this.consoleui.render();
				});
				this.consoleui.render();
			})
			.catch((err) => {
				this.consoleui.clientError(err);
				this.consoleui.hideWaitingBox();
			});
	}

	selectJobOption() {
		this.dryRunResults = null;
		let optionNames = Object.keys(this.consoleui.jobOptionClasses);
		let containerBox = blessed.box({
			width: '50%',
			border: {
				type: 'line'
			},
			height: '50%',
			top: 'center',
			left: 'center'
		});
		let boxTitle = blessed.box({
			width: '100%',
			height: 1,
			align: 'center',
			content: 'Configure Job Option'
		});
		containerBox.append(boxTitle);
		let listBox = blessed.list({
			style: {
				selected: {
					inverse: true
				},
				item: {
					inverse: false
				}
			},
			keys: true,
			items: optionNames,
			width: '100%-2',
			height: '100%-3',
			top: 1,
			border: {
				type: 'line'
			}
		});
		containerBox.append(listBox);
		this.box.append(containerBox);
		listBox.focus();
		listBox.on('select', () => {
			//this.box.remove(containerBox);
			let optionName = optionNames[listBox.selected];
			if (!this.jobOptionInstances[optionName]) {
				let cls = this.consoleui.jobOptionClasses[optionName];
				this.jobOptionInstances[optionName] = new cls(this.consoleui);
			}
			let r = this.jobOptionInstances[optionName].optionSelected();
			if (r && typeof r.then === 'function') {
				r.catch((err) => this.clientError(err))
				r.then(() => listBox.focus());
			}
			this.consoleui.render();
		});
		listBox.on('cancel', () => {
			containerBox.remove(listBox);
			this.box.remove(containerBox);
			this.consoleui.render();
		});
		this.consoleui.render();
	}

	uploadFile() {
		let fileSelector = blessed.filemanager({
			cwd: this.foleLastCwd,
			width: '50%',
			height: '50%',
			top: 'center',
			left: 'center',
			border: {
				type: 'line'
			},
			style: {
				selected: {
					inverse: true
				},
				item: {
					inverse: false
				}
			},
			keys: true
		});
		this.box.append(fileSelector);
		fileSelector.focus();
		fileSelector.once('cancel', () => {
			this.box.remove(fileSelector);
			this.consoleui.render();
		});
		fileSelector.once('file', (filename) => {
			this.fileLastCwd = fileSelector.cwd;
			this.box.remove(fileSelector);
			this.consoleui.render();
			this.consoleui.showWaitingBox('Uploading ...');
			fs.readFile(filename, (err, fileData) => {
				if (err) {
					this.consoleui.hideWaitingBox();
					this.consoleui.clientError(err);
					return;
				}
				fileData = fileData.toString('utf8');
				let fileBaseName = path.basename(filename);
				this.consoleui.client.op('uploadFile', {
					filename: fileBaseName,
					data: fileData
				})
					.then(() => {
						this.consoleui.hideWaitingBox();
						this.consoleui.showTempMessage('File uploaded.');
						this.jobFilename = fileBaseName;
						this.dryRunResults = null;
						this.updateJobInfoText();
					})
					.catch((err) => {
						this.consoleui.hideWaitingBox();
						this.consoleui.clientError(err);
					});
			});
		});
		this.consoleui.render();
		fileSelector.refresh();
	}

	makeJobOptionsObj() {
		let obj = {};
		if (this.jobFilename) obj.filename = this.jobFilename;
		if (!obj.filename) throw new XError(XError.INVALID_ARGUMENT, 'No filename specified');
		for (let key in this.jobOptionInstances) {
			this.jobOptionInstances[key].addToJobOptions(obj);
		}
		return obj;
	}

	jobDryRunToFile() {
		let inputBox = blessed.box({
			width: '50%',
			height: 3,
			border: {
				type: 'line'
			},
			top: 'center',
			left: 'center'
		});
		let inputTextbox = blessed.textbox({
			inputOnFocus: true,
			width: '100%',
			height: 1
		});
		inputBox.append(inputTextbox);
		this.box.append(inputBox);
		inputTextbox.focus();
		inputTextbox.on('submit', () => {
			let filename = inputTextbox.getValue();
			this.box.remove(inputBox);
			this.consoleui.render();
			if (!filename) return;
			this.jobDryRun(filename);
		});
		inputTextbox.on('cancel', () => {
			this.box.remove(inputBox);
			this.consoleui.render();
		});
		this.consoleui.render();
	}

	jobDryRun(toFile = null) {
		let jobOptions;
		try {
			jobOptions = this.makeJobOptionsObj();
		} catch (err) {
			this.consoleui.showTempMessage(err.message);
			return;
		}
		if (toFile) {
			if (!/(\.nc|\.gcode)$/i.test(toFile)) {
				toFile += '.nc';
			}
			jobOptions.outputFilename = toFile;
		}
		this.consoleui.showWaitingBox('Running ...');
		this.consoleui.client.op('jobDryRun', jobOptions)
			.then((result) => {
				this.dryRunResults = result;
				this.consoleui.showTempMessage('Dry run complete.');
				this.consoleui.hideWaitingBox();
				this.updateJobInfoText();
			})
			.catch((err) => {
				this.consoleui.clientError(err);
				this.consoleui.hideWaitingBox();
			});
	}

	jobStart() {
		let jobOptions;
		try {
			jobOptions = this.makeJobOptionsObj();
		} catch (err) {
			this.consoleui.showTempMessage(err.message);
			return;
		}
		this.consoleui.showWaitingBox('Initializing ...');
		this.consoleui.client.op('startJob', jobOptions)
			.then((result) => {
				if (result.dryRunResults) {
					this.dryRunResults = result.dryRunResults;
				}
				this.consoleui.showTempMessage('Starting job.');
				this.consoleui.hideWaitingBox();
				this.updateJobInfoText();
			})
			.catch((err) => {
				this.consoleui.clientError(err);
				this.consoleui.hideWaitingBox();
			});
	}

	resetJobInfo() {
		this.jobFilename = null;
		this.dryRunResults = null;
		this.jobOptionInstances = {};
		this.updateJobInfoText();
	}

	activateMode() {
		super.activateMode();
	}

	exitMode() {
		super.exitMode();
	}

	init() {
		super.init();
		
		this.jobInfoBox = blessed.box({
			width: '100%',
			height: '100%',
			content: '',
			align: 'center',
			valign: 'center',
			tags: true
		});
		this.box.append(this.jobInfoBox);
		this.updateJobInfoText();

		this.consoleui.registerHomeKey([ 'n', 'N' ], 'n', 'New Job', () => this.consoleui.activateMode('newJob'));
		
		this.registerModeKey([ 'escape' ], [ 'Esc' ], 'Home', () => this.consoleui.exitMode());
		this.registerModeKey([ 'f' ], [ 'f' ], 'Select File', () => this.selectJobFile());
		this.registerModeKey([ 'u' ], [ 'u' ], 'Upload File', () => this.uploadFile());
		this.registerModeKey([ 'o' ], [ 'o' ], 'Job Option', () => this.selectJobOption());
		this.registerModeKey([ 'r' ], [ 'r' ], 'Reset', () => this.resetJobInfo());
		this.registerModeKey([ 'd' ], [ 'd' ], 'Dry Run', () => this.jobDryRun());
		this.registerModeKey([ 'y' ], [ 'y' ], 'Run to File', () => this.jobDryRunToFile());
		this.registerModeKey([ 's' ], [ 's' ], 'Start Job', () => this.jobStart());
	}

}

module.exports = ModeNewJob;
module.exports.registerConsoleUI = function(consoleui) {
	consoleui.registerMode('newJob', new ModeNewJob(consoleui));
};

