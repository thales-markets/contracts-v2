const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;
	const newRequestConfirmations = 1;

	const subscriptionId = BigInt(getTargetAddress('VRFSubscriptionId', network));
	const keyHash = getTargetAddress('VRFKeyHash', network);

	const games = ['Roulette', 'Blackjack', 'Dice', 'Baccarat', 'Slots'];

	for (const name of games) {
		const addr = getTargetAddress(name, network);
		const contract = await ethers.getContractAt(name, addr);

		const currentConfirmations = await contract.requestConfirmations();
		const currentCallbackGasLimit = await contract.callbackGasLimit();
		const currentNativePayment = await contract.nativePayment();

		console.log(`${name} (${addr})`);
		console.log(`  requestConfirmations: ${currentConfirmations} -> ${newRequestConfirmations}`);

		if (Number(currentConfirmations) !== newRequestConfirmations) {
			const tx = await contract.setVrfConfig(
				subscriptionId,
				keyHash,
				currentCallbackGasLimit,
				newRequestConfirmations,
				currentNativePayment
			);
			await tx.wait();
			console.log(`  Updated. tx: ${tx.hash}`);
			await delay(3000);
		} else {
			console.log('  Already set');
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
