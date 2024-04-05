const { TYPE_ID_SPREAD, TYPE_ID_TOTAL, TYPE_ID_POINTS } = require('../constants/overtime');
const markets = require(`../../scripts/deployOvertime/updateMerkleTree/markets.json`);
const { ONE_DAY_IN_SECS, ONE_WEEK_IN_SECS } = require('../constants/general');
const { getMerkleTree } = require('./merkleTree/merkleTree');
const fs = require('fs');

const getTradeDataItem = (market, position) => {
	return {
		gameId: market.gameId,
		sportId: market.sportId,
		typeId: market.typeId,
		maturity: market.maturity,
		status: market.status,
		line: market.line,
		playerId: market.playerProps.playerId,
		odds: market.odds,
		merkleProof: market.proof,
		position: position,
		combinedPositions: market.combinedPositions || new Array(market.odds.length).fill([]),
	};
};

const getTicketTradeData = () => {
	const marketsTree = require(`./merkleTree/treeMarketsAndHashes.json`);
	const nbaMoneylineCurrentRound = marketsTree[0];
	const nbaMoneylineNextRound = marketsTree[1];
	const nbaSpreadNextRound = marketsTree[1].childMarkets[0];

	const tradeDataCurrentRound = [];
	tradeDataCurrentRound.push(getTradeDataItem(nbaMoneylineCurrentRound, 0));

	const tradeDataNextRound = [];
	tradeDataNextRound.push(getTradeDataItem(nbaMoneylineNextRound, 0));

	const tradeDataCrossRounds = [];
	tradeDataCrossRounds.push(getTradeDataItem(nbaMoneylineCurrentRound, 0));
	tradeDataCrossRounds.push(getTradeDataItem(nbaSpreadNextRound, 1));

	const tradeDataTenMarketsCurrentRound = [];
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[2], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[3], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[4], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[5], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[6], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[7], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[8], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[9], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[10], 0));
	tradeDataTenMarketsCurrentRound.push(getTradeDataItem(marketsTree[11], 0));

	const tradeIllegalCombinationCurrentRound = [];
	tradeIllegalCombinationCurrentRound.push(getTradeDataItem(marketsTree[2], 0));
	tradeIllegalCombinationCurrentRound.push(getTradeDataItem(marketsTree[2], 0));

	return {
		tradeDataCurrentRound,
		tradeDataNextRound,
		tradeDataCrossRounds,
		tradeDataTenMarketsCurrentRound,
		tradeIllegalCombinationCurrentRound,
	};
};

const createMerkleTree = async () => {
	const today = Math.round(new Date().getTime() / 1000);
	const tomorrow = today + ONE_DAY_IN_SECS;
	const nextWeek = tomorrow + ONE_WEEK_IN_SECS;

	const newMarkets = [];
	markets.forEach((market, index) => {
		market.maturity = index === 1 ? nextWeek : tomorrow;
		market.childMarkets.forEach((childMarket) => {
			childMarket.maturity = index === 1 ? nextWeek : tomorrow;
		});
		newMarkets.push(market);
	});

	const { root, treeMarketsAndHashes } = await getMerkleTree(newMarkets);

	fs.writeFileSync(
		`test/utils/merkleTree/treeMarketsAndHashes.json`,
		JSON.stringify(treeMarketsAndHashes),
		function (err) {
			if (err) return console.log(err);
		}
	);

	return root;
};

module.exports = {
	getTicketTradeData,
	getTradeDataItem,
	createMerkleTree,
};
