const blessed = require('blessed');
const TightCNCClient = require('../../lib/clientlib');
const pasync = require('pasync');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');

class ConsoleUI extends EventEmitter {

	constructor() {
		super();
		this.statusBoxes = [];
		this.hints = [];
		this.hintOverrideStack = [];
		this.config = require('littleconf').getConfig();
		this.hintBoxHeight = 3;
		this.modes = {};
		this.jobOptionClasses = {};
		this.enableRendering = true;
	}

	async initLog() {
		let logDir = this.config.consoleui.logDir;
		await new Promise((resolve, reject) => {
			mkdirp(logDir, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
		this.logFilename = path.join(logDir, 'consoleui.log');
		this.logFile = fs.openSync(this.logFilename, 'w');
		this.curLogSize = 0;
		this.maxLogSize = 2000000;
		this.logInited = true;
	}

	log(...args) {
		let str = '';
		for (let arg of args) {
			if (str) str += '; ';
			str += '' + arg;
		}
		if (str === this.lastLogStr) return;
		this.lastLogStr = str;
		if (!this.logInited) {
			console.log(str);
		} else {
			this.curLogSize += str.length + 1;
			if (this.curLogSize >= this.maxLogSize) {
				fs.closeSync(this.logFile);
				this.logFile = fs.openSync(this.logFilename, 'w');
			}
			fs.write(this.logFile, '' + str + '\n', (err) => {
				if (err) console.error('Error writing to log', err);
			});
		}
	}

	render() {
		if (this.screen && this.enableRendering) this.screen.render();
	}

	disableRender() {
		this.enableRendering = false;
	}

	enableRender() {
		this.enableRendering = true;
		this.render();
	}

	registerGlobalKey(keys, keyNames, keyLabel, fn) {
		if (!Array.isArray(keys)) keys = [ keys ];
		if (keyNames && !Array.isArray(keyNames)) keyNames = [ keyNames ];
		let hint = null;
		if (keyNames) {
			hint = this.addHint(keyNames, keyLabel);
		}
		this.screen.key(keys, fn);
		return hint;
	}

	_makeHintStr(keyNames, label) {
		if (!Array.isArray(keyNames)) keyNames = [ keyNames ];
		return keyNames.map((n) => '{inverse}' + n + '{/inverse}').join('/') + ' ' + label;
	}

	// hints is in form: [ [ keyNames, label ], [ keyNames, label ], ... ]
	pushHintOverrides(hints) {
		let hintStrs = hints.map((a) => this._makeHintStr(a[0], a[1]));
		this.hintOverrideStack.push(hintStrs);
		this.updateHintBox();
	}

	popHintOverrides() {
		this.hintOverrideStack.pop();
		this.updateHintBox();
	}

	addHint(keyNames, label) {
		this.hints.push(this._makeHintStr(keyNames, label));
		this.updateHintBox();
		return this.hints[this.hints.length - 1];
	}

	removeHint(hint) {
		this.hints = this.hints.filter((h) => h !== hint);
		this.updateHintBox();
	}

	updateHintBox() {
		let hints = this.hints;
		if (this.hintOverrideStack.length) hints = this.hintOverrideStack[this.hintOverrideStack.length - 1];
		if (!hints.length) {
			this.bottomHintBox.setContent('');
			return;
		}
		let totalWidth = this.bottomHintBox.width;
		let rowHints = [];
		let numRowsUsed = Math.min(Math.floor(hints.length / 6) + 1, this.hintBoxHeight);
		let hintsPerRow = Math.ceil(hints.length / numRowsUsed);
		let hintWidth = Math.floor(totalWidth / hintsPerRow);
		let hintsToShow = [];
		for (let i = 0; i < hintsPerRow * numRowsUsed; i++) {
			hintsToShow[i] = hints[i] || '';
		}
		let hintBoxContent = '';
		for (let rowNum = 0; rowNum < numRowsUsed; rowNum++) {
			if (rowNum != 0) hintBoxContent += '\n';
			hintBoxContent += '{center}';
			for (let hintIdx = rowNum * hintsPerRow; hintIdx < (rowNum + 1) * hintsPerRow; hintIdx++) {
				let hintStrLen = hintsToShow[hintIdx].replace(/\{[^}]*\}/g, '').length;
				let padLeft = Math.floor((hintWidth - hintStrLen) / 2);
				let padRight = Math.ceil((hintWidth - hintStrLen) / 2);
				for (let i = 0; i < padLeft; i++) hintBoxContent += ' ';
				hintBoxContent += hintsToShow[hintIdx];
				for (let i = 0; i < padRight; i++) hintBoxContent += ' ';
			}
			hintBoxContent += '{/center}';
		}
		this.bottomHintBox.setContent(hintBoxContent);
		this.render();
	}

	async runInModal(fn, options = {}) {
		let modal = blessed.box({
			width: options.width || '80%',
			height: options.height || '80%',
			top: 'center',
			left: 'center',
			border: options.border ? { type: 'line' } : undefined
			//border: { type: 'line' },
			//content: 'MODAL CONTENT'
		});
		let container = options.container || this.mainPane;
		container.append(modal);
		modal.setFront();
		this.screen.render();
		try {
			return await fn(modal);
		} finally {
			container.remove(modal);
		}
	}

	async runWithWait(fn, text = 'Waiting ...') {
		this.showWaitingBox(text);
		try {
			return await fn();
		} finally {
			this.hideWaitingBox();
		}
	}

	async showConfirm(content, options = {}, container = null) {
		if (!container) container = this.mainPane;
		let box = blessed.box({
			width: '50%',
			height: '30%',
			top: 'center',
			left: 'center',
			align: 'center',
			valign: 'middle',
			keyable: true,
			content: content,
			border: { type: 'line' }
		});
		let origGrabKeys = this.screen.grabKeys;
		let r = await new Promise((resolve, reject) => {
			this.pushHintOverrides([ [ 'Esc', options.cancelLabel || 'Cancel' ], [ 'Enter', options.okLabel || 'OK' ] ]);
			box.key([ 'escape' ], () => {
				resolve(false);
			});
			box.key([ 'enter' ], () => {
				resolve(true);
			});
			container.append(box);
			this.render();
			box.focus();
			this.screen.grabKeys = true;
		});
		this.popHintOverrides();
		container.remove(box);
		this.screen.grabKeys = origGrabKeys;
		this.screen.render();
		return r;
	}


	/**
	 * Adds a status box to the status box stack.
	 *
	 * @method addStatusBox
	 * @param {String} title - Status box title
	 * @param {Object} statusObj - An object mapping keys to status values to display.
	 * @param {Object} labels - Optional mapping from status keys to display labels for them.
	 * @return {Object} - A reference to the UI data for the box.
	 */
	addStatusBox(title, statusObj, labels = null) {
		if (!labels) {
			labels = {};
			for (let key in statusObj) labels[key] = key;
		}
		let boxData = {
			title: title,
			data: statusObj,
			labels: labels,
			titleBox: blessed.box({
				tags: true,
				width: '100%',
				height: 1,
				content: '{center}{bold}' + title + '{/bold}{/center}'
			}),
			box: blessed.box({
				tags: true,
				width: '100%',
				content: ''
			}),
			line: blessed.line({
				type: 'line',
				orientation: 'horizontal',
				width: '100%'
			})
		};
		this.statusBoxes.push(boxData);
		this.statusPane.append(boxData.titleBox);
		this.statusPane.append(boxData.box);
		this.statusPane.append(boxData.line);
		this.updateStatusBoxes();
		return boxData;
	}

	removeStatusBox(boxData) {
		let boxIdx = this.statusBoxes.indexOf(boxData);
		if (boxIdx === -1) {
			for (let i = 0; i < this.statusBoxes.length; i++) {
				if (this.statusBoxes[i].data === boxData) {
					boxIdx = i;
					boxData = this.statusBoxes[i];
					break;
				}
			}
			if (boxIdx === -1) return;
		}
		this.statusPane.remove(boxData.titleBox);
		this.statusPane.remove(boxData.box);
		this.statusPane.remove(boxData.line);
		this.statusBoxes.splice(boxIdx, 1);
		this.updateStatusBoxes();
	}

	updateStatusBoxes() {
		let vOffset = 0;
		for (let boxData of this.statusBoxes) {
			let numEntries = Object.keys(boxData.labels).length;
			boxData.box.position.height = numEntries;
			boxData.titleBox.position.top = vOffset;
			boxData.box.position.top = vOffset + 1;
			boxData.line.position.top = vOffset + 1 + numEntries;
			vOffset += numEntries + 2;
			let content = '';
			for (let key in boxData.labels) {
				if (content) content += '\n';
				let dataStr = boxData.data[key];
				if (dataStr === null || dataStr === undefined) dataStr = '';
				dataStr = '' + dataStr;
				content += boxData.labels[key] + ':{|}' + dataStr;
			}
			boxData.box.setContent(content);
		}
		this.render();
	}

	initUI() {
		this.screen = blessed.screen({
			smartCSR: true
		});
		this.screen.title = 'TightCNC Console UI';

		this.mainOuterBox = blessed.box({
			top: 0,
			height: '100%-' + (3 + this.hintBoxHeight)
		});
		this.screen.append(this.mainOuterBox);

		let messageSeparatorLine = blessed.line({
			type: 'line',
			orientation: 'horizontal',
			width: '100%',
			bottom: this.hintBoxHeight + 2
		});
		this.screen.append(messageSeparatorLine);

		this.messageBox = blessed.box({
			tags: true,
			bottom: this.hintBoxHeight + 1,
			width: '100%',
			height: 1,
			content: '',
			align: 'center'
		});
		this.screen.append(this.messageBox);

		let hintSeparatorLine = blessed.line({
			type: 'line',
			orientation: 'horizontal',
			width: '100%',
			bottom: this.hintBoxHeight
		});
		this.screen.append(hintSeparatorLine);

		this.bottomHintBox = blessed.box({
			tags: true,
			bottom: 0,
			height: this.hintBoxHeight,
			content: ''
		});
		this.screen.append(this.bottomHintBox);

		this.statusPane = blessed.box({
			left: 0,
			width: '20%',
			content: 'Status'
		});
		this.mainOuterBox.append(this.statusPane);

		let statusSeparatorLine = blessed.line({
			type: 'line',
			orientation: 'vertical',
			left: '20%',
			height: '100%'
		});
		this.mainOuterBox.append(statusSeparatorLine);

		this.mainPane = blessed.box({
			right: 0,
			width: '80%-1'
		});
		this.mainOuterBox.append(this.mainPane);

		this.screen.on('resize', () => {
			this.updateHintBox();
		});


		/*let testBox = blessed.box({
			width: '100%',
			height: '100%',
			content: '',
			input: true
		});
		testBox.key([ 'f', 'Esc' ], (ch, key) => {
			testBox.setContent('key pressed\n' + ch + '\n' + JSON.stringify(key));
			this.screen.render();
		});
		this.mainPane.append(testBox);
		testBox.focus();*/

		this.screen.render();

		//this.registerGlobalKey([ 'escape', 'C-c' ], [ 'Esc' ], 'Exit', () => process.exit(0));
	}

	registerJobOption(name, cls) {
		this.jobOptionClasses[name] = cls;
	}

	showWaitingBox(text = 'Waiting ...') {
		if (this.waitingBox) return;
		this.waitingBox = blessed.box({
			border: {
				type: 'line'
			},
			content: text,
			align: 'center',
			valign: 'middle',
			width: text.length + 2,
			height: 3,
			top: '50%-2',
			left: '50%-' + (Math.floor(text.length / 2) + 1)
		});
		this.mainOuterBox.append(this.waitingBox);
		this.screen.lockKeys = true;
		this.render();
	}

	hideWaitingBox() {
		if (!this.waitingBox) return;
		this.mainOuterBox.remove(this.waitingBox);
		delete this.waitingBox;
		this.screen.lockKeys = false;
		this.render();
	}

	pointToStr(pos) {
		let str = '';
		for (let axisNum = 0; axisNum < this.usedAxes.length; axisNum++) {
			if (this.usedAxes[axisNum]) {
				if (str) str += ', ';
				str += (pos[axisNum] || 0).toFixed(3);
			}
		}
		return str;
	}

	async initClient() {
		console.log('Connecting ...');
		this.client = new TightCNCClient(this.config);
		return await this.client.op('getStatus');
	}

	setupPrimaryStatusBoxes() {
		this.machineStateStatusBox = this.addStatusBox('Machine', { state: 'NOT READY', held: null, error: null }, { state: 'State', held: 'Hold', error: 'Err' });
		let posStatusInitial = {};
		let posStatusLabels = {};
		for (let i = 0; i < this.usedAxes.length; i++) {
			if (this.usedAxes[i]) {
				posStatusInitial[this.axisLabels[i]] = null;
				posStatusLabels[this.axisLabels[i]] = this.axisLabels[i].toUpperCase();
			}
		}
		this.positionStatusBox = this.addStatusBox('Pos Cur/Mach', posStatusInitial, posStatusLabels);
		this.miscStateStatusBox = this.addStatusBox('State', {
			activeCoordSys: null,
			allAxisHomed: null,
			units: null,
			feed: null,
			incremental: null,
			moving: null,
			spindle: null,
			coolant: null
		}, {
			moving: 'Moving',
			activeCoordSys: 'Coord',
			incremental: 'Inc',
			spindle: 'Spind',
			coolant: 'Cool',
			feed: 'Feed',
			units: 'Unit',
			allAxisHomed: 'Homed'
		});
		this.jobStatusBox = this.addStatusBox('Cur. Job', {
			state: 'NONE',
			percentComplete: '',
			timeRemaining: ''
		}, {
			state: 'State',
			percentComplete: '% Done',
			timeRemaining: 'Remain'
		});
	}

	updatePrimaryStatusBoxes(status) {
		if (!status) return;
		let cstatus = status.controller;

		// Machine state
		let machineState = null;
		let machineError = null;
		if (cstatus.error) {
			machineState = '{red-bg}ERROR{/red-bg}';
			if (cstatus.errorData && (cstatus.errorData.message || cstatus.errorData.msg)) {
				machineError = cstatus.errorData.message || cstatus.errorData.msg;
			} else if (cstatus.errorData) {
				machineError = JSON.stringify(cstatus.errorData);
			} else {
				machineError = 'Unknown';
			}
		} else if (cstatus.ready) {
			machineState = '{green-bg}READY{/green-bg}';
		} else {
			machineState = '{red-bg}NOT READY{/red-bg}';
		}
		this.machineStateStatusBox.data.state = machineState;
		this.machineStateStatusBox.data.error = machineError;
		this.machineStateStatusBox.data.held = cstatus.held ? '{red-bg}YES{/red-bg}' : 'NO';

		// Position
		const posPrecision = 3;
		for (let i = 0; i < this.usedAxes.length; i++) {
			if (this.usedAxes[i]) {
				let axis = this.axisLabels[i];
				let posStr = '';
				if (cstatus.pos && typeof cstatus.pos[i] === 'number') {
					posStr += cstatus.pos[i].toFixed(posPrecision);
				}
				if (cstatus.mpos && typeof cstatus.mpos[i] === 'number') {
					posStr += '{gray-fg}/' + cstatus.mpos[i].toFixed(posPrecision) + '{/gray-fg}';
				}
				this.positionStatusBox.data[axis] = posStr;
			}
		}

		// Misc
		this.miscStateStatusBox.data.activeCoordSys = (typeof cstatus.activeCoordSys === 'number') ? ('G' + (cstatus.activeCoordSys + 54)) : '';
		if (cstatus.homed) {
			this.miscStateStatusBox.data.allAxisHomed = '{green-fg}YES{/green-fg}';
			for (let i = 0; i < this.usedAxes.length; i++) {
				if (this.usedAxes[i] && !cstatus.homed[i]) {
					this.miscStateStatusBox.data.allAxisHomed = 'NO';
				}
			}
		} else {
			this.miscStateStatusBox.data.allAxisHomed = '';
		}
		this.miscStateStatusBox.data.units = cstatus.units;
		this.miscStateStatusBox.data.feed = (typeof cstatus.feed === 'number') ? cstatus.feed.toFixed(posPrecision) : '';
		const boolstr = (val, iftrue = '{yellow-fg}YES{/yellow-fg}', iffalse = 'NO') => {
			if (val) return iftrue;
			if (val === null || val === undefined || val === '') return '';
			return iffalse;
		};
		this.miscStateStatusBox.data.incremental = boolstr(cstatus.incremental);
		this.miscStateStatusBox.data.moving = boolstr(cstatus.moving);
		let spindleStr = '';
		if (cstatus.spindle === true && cstatus.spindleDirection === 1) {
			spindleStr = '{yellow-fg}FWD{/yellow-fg}';
		} else if (cstatus.spindle === true && cstatus.spindleDirection === -1) {
			spindleStr = '{yellow-fg}REV{/yellow-fg}';
		} else if (cstatus.spindle === true) {
			spindleStr = '{yellow-fg}ON{/yellow-fg}';
		} else if (cstatus.spindle === false) {
			spindleStr = 'OFF';
		}
		this.miscStateStatusBox.data.spindle = spindleStr;
		this.miscStateStatusBox.data.coolant = boolstr(cstatus.coolant, '{yellow-fg}ON{/yellow-fg}', 'OFF');

		// Job
		if (status.job && status.job.state !== 'none') {
			if (status.job.state === 'initializing') {
				this.jobStatusBox.data.state = '{blue-bg}INIT{/blue-bg}';
			} else if (status.job.state === 'running') {
				this.jobStatusBox.data.state = '{yellow-bg}RUN{/yellow-bg}';
			} else if (status.job.state === 'waiting') {
				this.jobStatusBox.data.state = '{blue-bg}WAIT{/blue-bg}';
			} else if (status.job.state === 'complete') {
				this.jobStatusBox.data.state = '{green-bg}DONE{/green-bg}';
			} else {
				this.jobStatusBox.data.state = '{red-bg}' + status.job.state.toUpperCase() + '{/red-bg}';
			}
			if (status.job.progress) {
				this.jobStatusBox.data.percentComplete = '' + status.job.progress.percentComplete.toFixed(1) + '%';
				let hoursRemaining = Math.floor(status.job.progress.estTimeRemaining / 3600);
				let minutesRemaining = Math.floor((status.job.progress.estTimeRemaining - hoursRemaining * 3600) / 60);
				if (minutesRemaining < 10) minutesRemaining = '0' + minutesRemaining;
				this.jobStatusBox.data.timeRemaining = '' + hoursRemaining + ':' + minutesRemaining;
			} else {
				this.jobStatusBox.data.percentComplete = '';
				this.jobStatusBox.data.timeRemaining = '';
			}
		} else {
			this.jobStatusBox.data.state = 'NONE';
			this.jobStatusBox.data.percentComplete = '';
			this.jobStatusBox.data.timeRemaining = '';
		}

		this.updateStatusBoxes();
	}

	setMessage(msg) {
		this.messageBox.setContent(msg);
		this.render();
	}

	showTempMessage(msg, time = 6) {
		this.setMessage(msg);
		if (this.curTempMessageTimeout) clearTimeout(this.curTempMessageTimeout);
		this.curTempMessageTimeout = setTimeout(() => {
			delete this.curTempMessageTimeout;
			this.setMessage('');
		}, time * 1000);
	}

	clientError(err) {
		this.showTempMessage(err.message || err.msg || ('' + err));
		this.log(err, err.stack);
	}

	runStatusUpdateLoop() {
		const runLoop = async() => {
			await this.serverPollLoop(async() => {
				let status;
				try {
					status = await this.client.op('getStatus');
					this.lastStatus = status;
					this.axisLabels = status.controller.axisLabels;
					this.usedAxes = status.controller.usedAxes;
					this.emit('statusUpdate', status);
				} catch (err) {
					this.clientError(err);
				}
				this.updatePrimaryStatusBoxes(status);
			});
		};
		runLoop().catch(this.clientError.bind(this));
	}

	registerMode(name, m) {
		this.modes[name] = m;
	}

	activateMode(name) {
		this.disableRender();
		if (this.activeMode) {
			this.modes[this.activeMode].exitMode();
		}
		this.modes[name].activateMode();
		this.activeMode = name;
		this.enableRender();
	}

	exitMode() {
		this.disableRender();
		this.modes[this.activeMode].exitMode();
		this.activeMode = null;
		this.activateMode('home');
		this.enableRender();
	}

	async registerModules() {
		require('./mode-home').registerConsoleUI(this);
		require('./mode-control').registerConsoleUI(this);
		require('./mode-log').registerConsoleUI(this);
		require('./mode-new-job').registerConsoleUI(this);
		require('./job-option-rawfile').registerConsoleUI(this);
		require('./mode-job-info').registerConsoleUI(this);

		// Register bundled plugins
		require('../plugins').registerConsoleUIComponents(this);

		// Register external plugins
		for (let plugin of (this.config.plugins || [])) {
			let p = require(plugin);
			if (p.registerConsoleUIComponents) {
				p.registerConsoleUIComponents(this);
			}
		}

		for (let mname in this.modes) {
			await this.modes[mname].init();
		}
	}

	registerHomeKey(keys, keyNames, keyLabel, fn, order = 1000) {
		this.modes['home'].registerHomeKey(keys, keyNames, keyLabel, fn, order);
	}

	async serverPollLoop(fn, minInterval = 300) {
		while (true) {
			let t1 = new Date().getTime();
			await fn();
			let t2 = new Date().getTime();
			let tDiff = t2 - t1;
			let waitTime = Math.max(minInterval, tDiff);
			await pasync.setTimeout(waitTime);
		}
	}

	async run() {
		try {
			await this.initLog();
		} catch (err) {
			console.error('Error initializing consoleui log', err, err.stack);
			process.exit(1);
		}

		let initStatus = await this.initClient();
		this.lastStatus = initStatus;
		this.axisLabels = initStatus.controller.axisLabels;
		this.usedAxes = initStatus.controller.usedAxes;

		this.initUI();
		await this.registerModules();

		this.setupPrimaryStatusBoxes();
		this.updatePrimaryStatusBoxes(initStatus);
		this.runStatusUpdateLoop();

		this.activateMode('home');

		this.log('ConsoleUI Started');
	}

}


new ConsoleUI().run().catch((err) => console.error(err, err.stack));

