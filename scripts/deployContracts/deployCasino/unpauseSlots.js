const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	const slotsAddress = getTargetAddress('Slots', network);
	const slots = await ethers.getContractAt('Slots', slotsAddress);

	const isPaused = await slots.paused();
	console.log('Slots paused:', isPaused);

	if (isPaused) {
		console.log('Unpausing...');
		const nonce = await owner.provider.getTransactionCount(owner.address, 'pending');
		const tx = await slots.setPausedByRole(false, { nonce });
		await tx.wait(1);
		console.log('Unpaused. tx:', tx.hash);
	} else {
		console.log('Already unpaused');
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
