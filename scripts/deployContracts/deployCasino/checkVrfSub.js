const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');
async function main() {
	const network = (await ethers.provider.getNetwork()).name;
	const vrfAddr = getTargetAddress('VRFCoordinator', network);
	const subId = getTargetAddress('VRFSubscriptionId', network);
	console.log(`VRFCoordinator: ${vrfAddr}`);
	console.log(`Subscription:   ${subId}`);
	// v2.5 ABI
	const abi = [
		'function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] consumers)',
		'function s_config() view returns (uint16, uint32, bool, uint32, uint32)',
	];
	const c = new ethers.Contract(vrfAddr, abi, ethers.provider);
	const sub = await c.getSubscription(subId);
	console.log(`\nSubscription state:`);
	console.log(
		`  LINK balance:   ${sub.balance} juels  (${ethers.formatUnits(sub.balance, 18)} LINK)`
	);
	console.log(
		`  native balance: ${sub.nativeBalance} wei  (${ethers.formatEther(sub.nativeBalance)} ETH)`
	);
	console.log(`  request count:  ${sub.reqCount}`);
	console.log(`  owner:          ${sub.owner}`);
	console.log(`  consumers:      ${sub.consumers.length}`);
	for (const cc of sub.consumers) console.log(`    ${cc}`);
	const bjAddr = getTargetAddress('Blackjack', network);
	const isBjConsumer = sub.consumers.map((x) => x.toLowerCase()).includes(bjAddr.toLowerCase());
	console.log(`\n  Blackjack ${bjAddr} is consumer? ${isBjConsumer}`);
}
main()
	.catch((e) => {
		console.error(e);
		process.exit(1);
	})
	.then(() => process.exit(0));
