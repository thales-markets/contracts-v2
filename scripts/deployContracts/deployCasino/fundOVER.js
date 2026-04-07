const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	const overAddress = getTargetAddress('OVER', network);
	const over = await ethers.getContractAt('IERC20', overAddress);
	const fundAmount = ethers.parseEther('1000'); // 1000 OVER (18 decimals)

	console.log('Owner:', owner.address);
	console.log('OVER address:', overAddress);
	console.log('OVER balance:', ethers.formatEther(await over.balanceOf(owner.address)));

	const games = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];
	for (const name of games) {
		const addr = getTargetAddress(name, network);
		const bal = await over.balanceOf(addr);
		if (bal < fundAmount) {
			await over.transfer(addr, fundAmount);
			console.log(`${name} (${addr}): funded with 1000 OVER`);
			await delay(3000);
		} else {
			console.log(`${name}: already has ${ethers.formatEther(bal)} OVER`);
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
