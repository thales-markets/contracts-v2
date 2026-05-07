const { deployV2Game } = require('./_deployV2Game');

deployV2Game('OvertimeHoldem', 'OvertimeHoldem')
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
