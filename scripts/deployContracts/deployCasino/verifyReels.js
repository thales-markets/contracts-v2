const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

async function main() {
	const network = (await ethers.provider.getNetwork()).name;
	const slots = await ethers.getContractAt('Slots', getTargetAddress('Slots', network));
	const reels = await slots.getSpinReels(1);
	console.log('Spin #1 reels:', reels.map(Number));
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
