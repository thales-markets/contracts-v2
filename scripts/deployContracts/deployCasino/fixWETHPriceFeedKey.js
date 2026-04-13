const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const network = (await ethers.provider.getNetwork()).name;

	console.log('Owner:', owner.address);
	console.log('Network:', network);

	const wethAddress = getTargetAddress('WETH', network);
	const correctKey = ethers.encodeBytes32String('ETH');

	console.log('WETH address:', wethAddress);
	console.log('Setting priceFeedKey to "ETH" (matching PriceFeed aggregator)\n');

	const games = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];

	for (const name of games) {
		const addr = getTargetAddress(name, network);
		const contract = await ethers.getContractAt(name, addr);

		const currentKey = await contract.priceFeedKeyPerCollateral(wethAddress);
		const currentKeyStr = ethers.decodeBytes32String(currentKey) || '(empty)';

		if (currentKey === correctKey) {
			console.log(`${name}: already set to "ETH", skipping`);
			continue;
		}

		console.log(`${name}: changing priceFeedKey from "${currentKeyStr}" to "ETH"`);
		const tx = await contract.setPriceFeedKeyPerCollateral(wethAddress, correctKey);
		await tx.wait();
		console.log(`${name}: done (tx: ${tx.hash})`);
		await delay(3000);
	}

	console.log('\nAll games updated.');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
