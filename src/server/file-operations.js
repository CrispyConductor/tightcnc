const Operation = require('./operation');
const fs = require('fs');
const path = require('path');

class OpListFiles extends Operation {
	getParamSchema() {
		return {};
	}
	async run(params) {
		let dir = this.tightcnc.config.dataDir;
		let files = await new Promise((resolve, reject) => {
			fs.readdir(dir, (err, files) => {
				if (err) reject(err);
				else resolve(files);
			});
		});
		let retfiles = [];
		for (let file of files) {
			let stat = await new Promise((resolve, reject) => {
				fs.stat(path.join(dir, file), (err, stat) => {
					if (err) reject(err);
					else resolve(stat);
				});
			});
			let type;
			if (stat.isDirectory()) {
				type = 'dir';
			} else if (stat.isFile() && /(\.gcode|\.nc)$/i.test(file)) {
				type = 'gcode';
			} else {
				type = 'other';
			}
			retfiles.push({
				name: file,
				type: type
			});
		}
		return retfiles;
	}
}

function registerOperations(tightcnc) {
	tightcnc.registerOperation('listFiles', OpListFiles);
}

module.exports = registerOperations;


