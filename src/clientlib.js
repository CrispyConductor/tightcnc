const request = require('request-promise-native');
const XError = require('xerror');

class SimpleCNCClient {

	constructor(config) {
		this.config = config;
	}

	async op(opname, params) {
		let url = this.config.host + ':' + (this.config.port || this.config.serverPort || 2363) + '/v1/jsonrpc';
		let requestData = {
			method: opname,
			params: params
		};
		let response = await request({
			url: url,
			method: 'POST',
			headers: {
				Authorization: 'Key ' + this.config.authKey,
				'Content-type': 'application/json'
			},
			body: JSON.stringify(requestData)
		});
		response = JSON.parse(response);
		if (response.error) {
			throw new XError.fromObject(response.error);
		}
		return response.result;
	}

}

module.exports = SimpleCNCClient;

