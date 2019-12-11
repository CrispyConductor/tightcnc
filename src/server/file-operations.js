const Operation = require('./operation');
const fs = require('fs');
const path = require('path');
const commonSchema = require('common-schema');
const XError = require('xerror');

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
		let fullFilename = path.resolve(this.tightcnc.config.dataDir, params.filename);
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


