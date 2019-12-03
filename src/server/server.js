const { APIRouter, JSONRPCInterface } = require('yaar');
const express = require('express');
const config = require('littleconf').getConfig();
const OpManager = require('./op-manager');
const { createSchema, Schema } = require('common-schema');
const XError = require('xerror');

async function startServer() {

	const router = new APIRouter();
	const app = express();
	app.use(router.getExpressRouter());
	router.version(1).addInterface(new JSONRPCInterface());

	let opmanager = new OpManager(config);
	await opmanager.init();

	function authMiddleware(ctx) {
		let authHeader = ctx.req.header('Authorization');
		if (!authHeader) throw new XError(XError.ACCESS_DENIED, 'Authorization header is required.');

		let parts = authHeader.split(' ');
		if (parts.length > 2) parts[1] = parts.slice(1).join(' ');
		let authType = parts[0].toLowerCase();
		let authString = parts[1];

		if (authType === 'key') {
			if (config.authKey && authString === config.authKey) {
				return;
			} else {
				throw new XError(XError.ACCESS_DENIED, 'Incorrect authentication key.');
			}
		} else {
			throw new XError(XError.ACCESS_DENIED, 'Unsupported authorization type: ' + authType);
		}
	}

	function registerOperationAPICall(operationName, operation) {
		let paramSchema = operation.getParamSchema();
		if (paramSchema && !Schema.isSchema(paramSchema)) paramSchema = createSchema(paramSchema);
		router.register(
			{
				method: operationName,
				schema: paramSchema
			},
			authMiddleware,
			async (ctx) => {
				let result = await operation.run(ctx.params);
				if (!result) result = { success: true };
				return result;
			}
		);
	}

	for (let operationName in opmanager.operations) {
		registerOperationAPICall(operationName, opmanager.operations[operationName]);
	}

	let serverPort = config.serverPort || 2363;
	app.listen(serverPort, (err) => {
		if (err) {
			console.error('Error listening on port ' + serverPort + ': ' + err);
			return;
		}
		console.log('Listening on port ' + serverPort);
	});

}

startServer()
	.catch((err) => {
		console.error(err);
		console.error(err.stack);
	});

