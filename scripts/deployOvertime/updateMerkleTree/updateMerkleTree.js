const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

async function updateMerkleTree() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	// if (networkObj.chainId == 420) {
	// 	networkObj.name = 'optimisticGoerli';
	// 	network = 'optimisticGoerli';
	// }

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const root = await getMerkleTreeRoot();

	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);
	console.log('Found SportsAMMV2 at:', sportsAMMV2Address);

	const sportsAMMV2Contract = await ethers.getContractFactory('SportsAMMV2');
	const sportsAMMV2 = sportsAMMV2Contract.attach(sportsAMMV2Address);

	// set new root on contract
	const tx = await sportsAMMV2.setRootPerGame(
		'0x3063613139613935343563616437636230393634613865623435363366336666',
		root
	);
	await tx.wait().then(() => {
		console.log(
			'New root set for game 0x3063613139613935343563616437636230393634613865623435363366336666'
		);
	});
}

updateMerkleTree()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
