const mkdirp = require('mkdirp');
const fs = require('fs');
const path = require('path');

class LoggerDisk {

	constructor(config = {}) {
		this.logDir = config.logDir || '/tmp/tightcnc-log';
		this.maxFileSize = config.maxFileSize || 1000000;
		this.keepFiles = config.keepFiles || 2;
	}

	async init() {
		// Create directory if doesn't exist
		await new Promise((resolve, reject) => {
			mkdirp(this.logDir, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
		// Get list of all log files currently in directory
		let files = await new Promise((resolve, reject) => {
			fs.readdir(this.logDir, (err, files) => {
				if (err) reject(err);
				else resolve(files);
			});
		});
		this.curFiles = [];
		for (let f of files) {
			let matches = /^cnc-([0-9]+)\.log$/.exec(f);
			if (matches) {
				let num = parseInt(matches[1], 10);
				let stats = await new Promise((resolve, reject) => {
					fs.stat(path.join(this.logDir, f), (err, stats) => {
						if (err) reject(err);
						else resolve(stats);
					});
				});
				this.curFiles.push({ filename: f, num: num, size: stats.size });
			}
		}
		this.curFiles.sort((a, b) => a.num - b.num);
		// Create new file if none exist
		if (!this.curFiles.length) this.curFiles.push({ filename: 'cnc-0001.log', num: 1, size: 0 });
		// Open most recent file
		let fullFn = path.join(this.logDir, this.curFiles[this.curFiles.length - 1].filename);
		this.curStream = fs.createWriteStream(fullFn, { flags: 'a' });
	}

	/**
	 * Log a message to disk.
	 *
	 * @method log
	 * @param {String} type - 'send', 'receive', or 'other'
	 * @param {Mixed} msg
	 */
	log(type, msg) {
		if (typeof msg !== 'string') msg = JSON.stringify(msg);
		if (type === 'send') msg = '> ' + msg;
		else if (type === 'receive') msg = '< ' + msg;
		else msg = '@ ' + msg;
		msg = msg.trim();
		msg += '\n';
		this.curStream.write(msg);
		this.curFiles[this.curFiles.length - 1].size += msg.length;
		if (this.curFiles[this.curFiles.length - 1].size >= this.maxFileSize) {
			this.curStream.end();
			let newNum = this.curFiles[this.curFiles.length - 1].num + 1;
			let newNumStr = '' + newNum;
			while (newNumStr.length < 4) newNumStr = '0' + newNumStr;
			let newFilename = 'cnc-' + newNumStr + '.log';
			this.curFiles.push({ filename: newFilename, num: newNum, size: 0 });
			this.curStream = fs.createWriteStream(path.join(this.logDir, newFilename), { flags: 'w' });
			while (this.curFiles.length > this.keepFiles) {
				let fileToDelete = this.curFiles.shift();
				fs.unlink(path.join(this.logDir, fileToDelete.filename), (err) => {
					if(err) console.error('LoggerDisk error removing file', err);
				});
			}
		}
	}

}

module.exports = LoggerDisk;

