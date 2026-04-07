const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const network = (await ethers.provider.getNetwork()).name;

	const correctOVER = '0xec60249ee888ffde5ee09920c9644a904d4f49de';
	const wrongOVER = '0xdDEDfAF154a0228cD15b2FDAaEc9F0ADA5fae2a2';
	const overPriceFeedKey = ethers.encodeBytes32String('OVER');

	const over = await ethers.getContractAt('IERC20', correctOVER);
	const fundAmount = ethers.parseEther('1000');

	const games = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];

	for (const name of games) {
		const addr = getTargetAddress(name, network);
		const contract = await ethers.getContractAt(name, addr);

		// Disable old OVER address
		const oldSupported = await contract.supportedCollateral(wrongOVER);
		if (oldSupported) {
			await contract.setSupportedCollateral(wrongOVER, false);
			console.log(`${name}: disabled old OVER`);
			await delay(3000);
		}

		// Enable correct OVER address
		const newSupported = await contract.supportedCollateral(correctOVER);
		if (!newSupported) {
			await contract.setSupportedCollateral(correctOVER, true);
			console.log(`${name}: enabled correct OVER`);
			await delay(3000);
		}

		// Set price feed key for correct OVER
		await contract.setPriceFeedKeyPerCollateral(correctOVER, overPriceFeedKey);
		console.log(`${name}: set price feed key for OVER`);
		await delay(3000);

		// Fund with 1000 OVER
		const bal = await over.balanceOf(addr);
		if (bal < fundAmount) {
			await over.transfer(addr, fundAmount);
			console.log(`${name}: funded with 1000 OVER`);
			await delay(3000);
		} else {
			console.log(`${name}: already has ${ethers.formatEther(bal)} OVER`);
		}

		console.log('');
	}

	console.log('Done. Remaining OVER:', ethers.formatEther(await over.balanceOf(owner.address)));
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
