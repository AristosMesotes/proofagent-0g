// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

import {SettlementOracle} from "../src/SettlementOracle.sol";

// =================================================================================================
// STATUS: BUILT, NOT DEPLOYED (honesty doctrine -- "claim only what is live").
// This script compiles and is ready to broadcast, but NO live deployment has been performed from it.
// The live deploy is OPERATOR-GATED and intentionally not run here. There is no on-chain oracle
// address to pin yet.
//
// DeploySettlementOracle -- the Foundry deploy script for the HONEST {SettlementOracle}: the on-chain
// settlement gate that releases a cross-chain solver ONLY on a `Settled` verdict (never on a Hollow
// fill). It reads the verifier-operator (attestor) address from the environment (nothing sensitive is
// hardcoded; the RPC endpoint and the deployer key come from the env, never the source). The script
// targets 0G only and REFUSES to broadcast against any other chain (see {WrongChain}), so the oracle
// can never be deployed to an unintended network by accident (testnet/dev only for live legs).
//
// The SettlementOracle holds NO funds and is non-custodial (a pure verdict registry + gate), so it is
// fully deployable + demoable on the 0G Galileo TESTNET (16602) at $0 (it is your own contract).
//
// THE EXACT OPERATOR COMMAND:
//
//   set -a; . ./.env; set +a                       # OG_RPC_TESTNET / demo wallet from the gitignored .env
//   SETTLEMENT_ATTESTOR=<verifier-operator-address> \   # the address authorized to post verdicts
//   OG_RPC=$OG_RPC_TESTNET \
//   forge script script/DeploySettlementOracle.s.sol:DeploySettlementOracle \
//     --rpc-url og --broadcast --private-key $PRIVATE_KEY
//
// After a confirmed broadcast, pin the deployed address where the verifier/settler integration reads
// it (claim only what's live). The deployer's PRIVATE_KEY is supplied to `forge script` via the
// CLI/env and is NEVER read or printed by this contract.
// =================================================================================================

/// @dev Minimal inline cheatcode interface -- the repo vendors NO external Solidity libraries
///      (clean-room / offline-by-default), so we declare only the handful of Foundry cheatcodes this
///      script needs instead of importing forge-std's `Script`. The cheatcode address is derived as
///      `address(uint160(uint256(keccak256("hevm cheat code"))))`, Foundry's well-known VM address --
///      no hardcoded magic literal.
interface IVm {
    function envAddress(string calldata name) external view returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @title DeploySettlementOracle -- deploy the honest {SettlementOracle} on 0G (non-custodial gate).
///        Guards the active chain id FIRST so it can only broadcast to 0G.
contract DeploySettlementOracle {
    IVm internal constant VM = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice 0G Aristotle mainnet chain id (proofagent.toml [chain].id).
    uint256 internal constant OG_MAINNET_CHAIN_ID = 16661;
    /// @notice 0G Galileo testnet chain id (proofagent.toml [chain].testnet).
    uint256 internal constant OG_TESTNET_CHAIN_ID = 16602;

    /// @dev Reverts if the active chain is neither 0G mainnet nor 0G testnet. The oracle gates a
    ///      money-bearing settler, so it must never be broadcast to the wrong network -- the on-chain
    ///      half of "testnet/dev only for live legs". `actual` is the chain id the connected RPC reported.
    error WrongChain(uint256 actual);

    /// @notice Deploy {SettlementOracle} to 0G with the attestor (verifier operator) drawn from the
    ///         environment. Guards the active chain id FIRST (a wrong-network deploy is rejected before
    ///         any broadcast), then reads the attestor, then broadcasts the constructor. The chain
    ///         guard runs in both dry-run and `--broadcast` modes, so a misconfigured RPC fails loudly
    ///         in simulation -- never silently on-chain.
    /// @return oracle  The freshly-deployed settlement oracle (its address is logged by `forge script`).
    function run() external returns (SettlementOracle oracle) {
        // (0) Chain guard -- target 0G only. `block.chainid` is the id the connected RPC reported;
        //     reject anything that is not 0G mainnet (16661) or 0G testnet (16602).
        requireOgChain(block.chainid);

        // The verifier operator authorized to post verdicts (REQUIRED; the constructor rejects zero).
        address attestor = VM.envAddress("SETTLEMENT_ATTESTOR");

        VM.startBroadcast();
        oracle = new SettlementOracle(attestor);
        VM.stopBroadcast();
    }

    /// @notice Target-chain guard: reverts with {WrongChain} unless `chainId` is 0G mainnet (16661) or
    ///         0G testnet (16602). Pure + self-contained so the safety invariant is unit-testable
    ///         without the env/broadcast machinery of {run}.
    /// @param chainId  The active chain id (the connected RPC's reported id, i.e. `block.chainid`).
    function requireOgChain(uint256 chainId) public pure {
        if (chainId != OG_MAINNET_CHAIN_ID && chainId != OG_TESTNET_CHAIN_ID) {
            revert WrongChain(chainId);
        }
    }
}
