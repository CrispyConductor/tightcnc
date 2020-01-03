const Operation = require('./operation');
const fs = require('fs');
const path = require('path');
const commonSchema = require('common-schema');
const XError = require('xerror');

class OpListFiles extends Operation {
	getParamSchema() {
		return {
			dir: {
				type: 'string',
				required: true,
				default: 'data',
				description: 'Name of directory to list'
			}
		};
	}
	async run(params) {
		let dir = this.tightcnc.getFilename(null, params.dir, false, true, true);
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
				type: type,
				mtime: stat.mtime.toISOString()
			});
		}
		retfiles.sort((a, b) => {
			if (a.mtime > b.mtime) return -1;
			if (a.mtime < b.mtime) return 1;
			if (a.name < b.name) return -1;
			if (a.name > b.name) return 1;
			return 0;
		});
		return retfiles;
	}
}

class OpUploadFile extends Operation {
	getParamSchema() {
		return {
			filename: {
				type: String,
				required: true,
				description: 'Remote filename to save file as',
				validate: (val) => {
					if (!(/\.(nc|gcode)$/i.test(val))) throw new commonSchema.FieldError('invalid', 'Filename must end in .nc or .gcode');
					if (val.indexOf('/') !== -1) throw new commonSchema.FieldError('invalid', 'Subdirectories not supported');
				}
			},
			data: {
				type: String,
				required: true,
				description: 'File data'
			}
		};
	}
	async run(params) {
		let fullFilename = this.tightcnc.getFilename(params.filename, 'data', false, true);
		await new Promise((resolve, reject) => {
			fs.writeFile(fullFilename, params.data, (err) => {
				if (err) reject(new XError(err));
				else resolve();
			});
		});
	}
}

function registerOperations(tightcnc) {
	tightcnc.registerOperation('listFiles', OpListFiles);
	tightcnc.registerOperation('uploadFile', OpUploadFile);
}

module.exports = registerOperations;


