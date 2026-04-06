const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

async function main() {
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	const vrfAddr = getTargetAddress('VRFCoordinator', network);
	const code = await ethers.provider.getCode(vrfAddr);
	console.log('VRF code length:', code.length);

	// Check if it's our MockVRFCoordinator
	const mock = await ethers.getContractAt('MockVRFCoordinator', vrfAddr);
	try {
		const lastReq = await mock.lastRequestId();
		console.log('MockVRFCoordinator lastRequestId:', lastReq.toString());
		console.log('This is a MOCK VRF coordinator');

		// Try to add consumer by calling spin and seeing what happens
		const slotsAddr = getTargetAddress('Slots', network);
		console.log('Slots address:', slotsAddr);

		// Check if we can call fulfillRandomWords manually on the mock
		console.log('Mock VRF is deployed - spin should work since mock just returns requestId');
	} catch (e) {
		console.log('Not a mock coordinator:', e.message);

		// Try as real Chainlink VRFCoordinatorV2_5
		try {
			const subId = BigInt(getTargetAddress('VRFSubscriptionId', network));
			const slotsAddr = getTargetAddress('Slots', network);

			// Try calling addConsumer
			const vrfAbi = [
				'function addConsumer(uint256 subId, address consumer) external',
				'function getSubscription(uint256 subId) external view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] memory consumers)',
			];
			const vrf = new ethers.Contract(vrfAddr, vrfAbi, (await ethers.getSigners())[0]);

			try {
				const sub = await vrf.getSubscription(subId);
				console.log('Subscription owner:', sub.subOwner);
				console.log('Consumers:', sub.consumers);
				console.log('Balance:', sub.balance.toString());

				const isConsumer = sub.consumers
					.map((c) => c.toLowerCase())
					.includes(slotsAddr.toLowerCase());
				console.log('Slots is consumer:', isConsumer);

				if (!isConsumer) {
					console.log('Adding Slots as VRF consumer...');
					const tx = await vrf.addConsumer(subId, slotsAddr);
					await tx.wait();
					console.log('Slots added as VRF consumer');
				}
			} catch (subErr) {
				console.log('Could not get subscription:', subErr.message);
			}
		} catch (vrfErr) {
			console.log('VRF error:', vrfErr.message);
		}
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
