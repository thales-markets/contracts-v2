const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

async function main() {
	const network = (await ethers.provider.getNetwork()).name;
	console.log('Network:', network);

	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const wethAddress = getTargetAddress('WETH', network);
	const overAddress = getTargetAddress('OVER', network);
	const priceFeedAddress = getTargetAddress('PriceFeed', network);

	console.log('\nAddresses from deployments.json:');
	console.log('  USDC:', usdcAddress);
	console.log('  WETH:', wethAddress);
	console.log('  OVER:', overAddress);
	console.log('  PriceFeed:', priceFeedAddress);

	// Check PriceFeed rates
	console.log('\n========== PRICE FEED ==========');
	const priceFeedAbi = ['function rateForCurrency(bytes32 currencyKey) view returns (uint)'];
	const priceFeed = new ethers.Contract(priceFeedAddress, priceFeedAbi, ethers.provider);

	const wethKey = ethers.encodeBytes32String('WETH');
	const overKey = ethers.encodeBytes32String('OVER');

	try {
		const wethRate = await priceFeed.rateForCurrency(wethKey);
		console.log(
			'WETH rate:',
			wethRate > 0 ? ethers.formatEther(wethRate) + ' USD' : '0 (NOT CONFIGURED!)'
		);
	} catch (e) {
		console.log('WETH rate: FAILED -', e.message?.slice(0, 100));
	}

	try {
		const overRate = await priceFeed.rateForCurrency(overKey);
		console.log(
			'OVER rate:',
			overRate > 0 ? ethers.formatEther(overRate) + ' USD' : '0 (NOT CONFIGURED!)'
		);
	} catch (e) {
		console.log('OVER rate: FAILED -', e.message?.slice(0, 100));
	}

	// Check each game
	const games = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];
	const collaterals = [
		{ name: 'USDC', address: usdcAddress, decimals: 6 },
		{ name: 'WETH', address: wethAddress, decimals: 18 },
		{ name: 'OVER', address: overAddress, decimals: 18 },
	];

	for (const gameName of games) {
		const gameAddress = getTargetAddress(gameName, network);
		console.log(`\n========== ${gameName} (${gameAddress}) ==========`);

		const game = await ethers.getContractAt(gameName, gameAddress);

		for (const col of collaterals) {
			const supported = await game.supportedCollateral(col.address);
			const feedKey = await game.priceFeedKeyPerCollateral(col.address);
			const feedKeyStr = ethers.decodeBytes32String(feedKey) || '(empty)';

			const token = await ethers.getContractAt('IERC20', col.address);
			const balance = await token.balanceOf(gameAddress);
			const formattedBal = ethers.formatUnits(balance, col.decimals);

			let availLiq = 'N/A';
			try {
				const liq = await game.getAvailableLiquidity(col.address);
				availLiq = ethers.formatUnits(liq, col.decimals);
			} catch (e) {
				availLiq = 'ERROR: ' + (e.message?.slice(0, 60) || e);
			}

			const issues = [];
			if (!supported) issues.push('NOT SUPPORTED');
			if (feedKey === ethers.ZeroHash && col.name !== 'USDC') issues.push('NO PRICE FEED KEY');
			if (balance === 0n) issues.push('ZERO BALANCE');

			const status = issues.length > 0 ? '  [' + issues.join(', ') + ']' : '  [OK]';

			console.log(
				`  ${col.name}: supported=${supported} feedKey="${feedKeyStr}" ` +
					`balance=${formattedBal} availLiq=${availLiq}${status}`
			);
		}
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
