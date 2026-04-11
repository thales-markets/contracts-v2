const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

// Registers the currently-deployed Slots proxy as a VRF v2.5 consumer on the
// subscription stored in deployments.json. Optionally removes an OLD_SLOTS
// address (passed via env) from the consumer list in the same run.
//
// Usage:
//   npx hardhat run scripts/deployContracts/deployCasino/addSlotsVrfConsumer.js --network optimisticSepolia
//   OLD_SLOTS=0x504db61a2fcD382373a82cFaB279e8Ea7a235Ee4 npx hardhat run ... --network optimisticSepolia

async function main() {
	const [owner] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;
	console.log('Signer: ', owner.address);
	console.log('Network:', network);

	const vrfCoordAddr = getTargetAddress('VRFCoordinator', network);
	const subId = BigInt(getTargetAddress('VRFSubscriptionId', network));
	const slotsAddress = getTargetAddress('Slots', network);
	const OLD_SLOTS = process.env.OLD_SLOTS;

	console.log('VRFCoordinator:   ', vrfCoordAddr);
	console.log('Subscription ID:  ', subId.toString());
	console.log('New Slots:        ', slotsAddress);
	if (OLD_SLOTS) console.log('Old Slots (remove):', OLD_SLOTS);

	const vrfAbi = [
		'function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] consumers)',
		'function addConsumer(uint256 subId, address consumer)',
		'function removeConsumer(uint256 subId, address consumer)',
	];
	const vrf = new ethers.Contract(vrfCoordAddr, vrfAbi, owner);

	let sub = await vrf.getSubscription(subId);
	console.log('\nSub owner:    ', sub.subOwner);
	console.log('Consumers:    ', sub.consumers.length);

	if (sub.subOwner.toLowerCase() !== owner.address.toLowerCase()) {
		console.error('\nERROR: signer is not the VRF subscription owner. Cannot modify consumers.');
		process.exit(1);
	}

	const consumerSet = new Set(sub.consumers.map((c) => c.toLowerCase()));
	const isAlreadyConsumer = consumerSet.has(slotsAddress.toLowerCase());

	if (isAlreadyConsumer) {
		console.log('\nNew Slots is already a consumer, skipping addConsumer');
	} else {
		console.log('\nAdding new Slots as consumer...');
		const tx = await vrf.addConsumer(subId, slotsAddress);
		console.log('  tx:', tx.hash);
		await tx.wait(1);
		await delay(3000);
		console.log('  added');
	}

	if (OLD_SLOTS) {
		const oldIsConsumer = consumerSet.has(OLD_SLOTS.toLowerCase());
		if (oldIsConsumer) {
			console.log('\nRemoving old Slots as consumer...');
			const tx = await vrf.removeConsumer(subId, OLD_SLOTS);
			console.log('  tx:', tx.hash);
			await tx.wait(1);
			await delay(3000);
			console.log('  removed');
		} else {
			console.log('\nOld Slots not in consumer list, skipping removeConsumer');
		}
	}

	// Verify
	sub = await vrf.getSubscription(subId);
	const nowConsumer = sub.consumers
		.map((c) => c.toLowerCase())
		.includes(slotsAddress.toLowerCase());
	console.log('\nVerification:');
	console.log(`  Slots is VRF consumer: ${nowConsumer}`);
	console.log(`  Consumer count:        ${sub.consumers.length}`);
	if (!nowConsumer) {
		console.error('ERROR: Slots still not a consumer after addConsumer. Investigate.');
		process.exit(1);
	}
	console.log('\nDone.');
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
