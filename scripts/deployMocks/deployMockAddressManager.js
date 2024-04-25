const { ethers } = require('hardhat');

const { setTargetAddress, getTargetAddress, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const zero_address = '0x0000000000000000000000000000000000000000';
	const protocolDAOAddress = getTargetAddress('ProtocolDAO', network);
	const safeBoxAddress = getTargetAddress('SafeBox', network);
	const referralsAddress = getTargetAddress('Referrals', network);
	const stakingThalesAddress = getTargetAddress('StakingThales', network);
	const multiCollateralAddress = getTargetAddress('MultiCollateral', network);
	const MockAddressManager = await ethers.getContractFactory('MockAddressManager');

	const mockAddressManagerDeployed = await upgrades.deployProxy(
		MockAddressManager,
		[
			protocolDAOAddress,
			safeBoxAddress,
			referralsAddress,
			stakingThalesAddress,
			multiCollateralAddress,
			zero_address,
			zero_address,
		],
		{ initialOwner: protocolDAOAddress }
	);
	await mockAddressManagerDeployed.waitForDeployment();

	const mockAddressManagerAddress = await mockAddressManagerDeployed.getAddress();
	console.log('MockAddressManager deployed on:', mockAddressManagerAddress);
	setTargetAddress('AddressManager', network, mockAddressManagerAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: mockAddressManagerAddress,
			contract: 'contracts/utils/test-helpers/MockAddressManager.sol:MockAddressManager',
		});
	} catch (e) {
		console.log(e);
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
