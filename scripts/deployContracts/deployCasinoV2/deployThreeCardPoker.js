const { deployV2Game } = require('./_deployV2Game');

deployV2Game('ThreeCardPoker', 'ThreeCardPoker')
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
