const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

const REFERRALS_ABI = [
	'function setWhitelistedAddress(address _address, bool enabled) external',
	'function whitelistedAddresses(address) external view returns (bool)',
	'function owner() external view returns (address)',
	'function referrerFeeDefault() external view returns (uint256)',
	'function setReferrerFees(uint256, uint256, uint256) external',
];

async function main() {
	const owner = (await ethers.getSigners())[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	const referralsAddress = getTargetAddress('Referrals', network);
	const referrals = new ethers.Contract(referralsAddress, REFERRALS_ABI, owner);

	const games = [
		{ name: 'Dice', address: getTargetAddress('Dice', network) },
		{ name: 'Roulette', address: getTargetAddress('Roulette', network) },
		{ name: 'Blackjack', address: getTargetAddress('Blackjack', network) },
		{ name: 'Baccarat', address: getTargetAddress('Baccarat', network) },
		{ name: 'Slots', address: getTargetAddress('Slots', network) },
	];

	console.log('Owner:', owner.address);
	console.log('Referrals:', referralsAddress);
	console.log('Default referrer fee:', ethers.formatEther(await referrals.referrerFeeDefault()));

	// Set referrer fees if not already set
	const currentFee = await referrals.referrerFeeDefault();
	if (currentFee === 0n) {
		console.log('\nSetting referrer fees (0.5% default, 1% silver, 2% gold)...');
		await referrals.setReferrerFees(
			ethers.parseEther('0.005'), // 0.5% default
			ethers.parseEther('0.01'), // 1% silver
			ethers.parseEther('0.02') // 2% gold
		);
		await delay(3000);
		console.log('Referrer fees set');
	}

	// Set referrals address on each casino contract and whitelist in Referrals
	for (const game of games) {
		const contract = await ethers.getContractAt(game.name, game.address);

		// Set referrals address on the casino contract
		const currentReferrals = await contract.referrals();
		if (currentReferrals !== referralsAddress) {
			console.log(`\nSetting referrals on ${game.name}...`);
			await contract.setReferrals(referralsAddress);
			await delay(3000);
			console.log(`${game.name} referrals set to ${referralsAddress}`);
		} else {
			console.log(`\n${game.name} already has referrals set`);
		}

		// Whitelist casino contract in Referrals
		console.log(`Whitelisting ${game.name} (${game.address}) in Referrals...`);
		try {
			await referrals.setWhitelistedAddress(game.address, true);
			await delay(3000);
			console.log(`${game.name} whitelisted`);
		} catch (e) {
			console.log(`${game.name} whitelist skipped:`, e.message?.slice(0, 100));
		}
	}

	console.log('\nAll casino contracts configured with referrals.');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
