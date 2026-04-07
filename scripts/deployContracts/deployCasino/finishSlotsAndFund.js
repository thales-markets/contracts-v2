const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	const slotsAddress = getTargetAddress('Slots', network);
	const slots = await ethers.getContractAt('Slots', slotsAddress);

	// Check if triple payout[4] needs setting
	const tp4 = await slots.triplePayout(4);
	if (tp4 === 0n) {
		await slots.setTriplePayout(4, ethers.parseEther('50'));
		console.log('Slots triple payout[4] = 50x');
		await delay(3000);
	} else {
		console.log('Slots triple payout[4] already set:', ethers.formatEther(tp4));
	}

	// Fund all bankrolls
	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const usdc = await ethers.getContractAt('IERC20', usdcAddress);
	const fundAmount = ethers.parseUnits('500', 6);

	const games = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];
	for (const name of games) {
		const addr = getTargetAddress(name, network);
		const bal = await usdc.balanceOf(addr);
		if (bal < fundAmount) {
			await usdc.transfer(addr, fundAmount);
			console.log(`${name} (${addr}): funded with 500 USDC`);
			await delay(3000);
		} else {
			console.log(`${name}: already has ${ethers.formatUnits(bal, 6)} USDC`);
		}
	}

	console.log('\nDone');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
