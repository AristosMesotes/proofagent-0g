// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockGuard, IMandateGate} from "../src/TimelockGuard.sol";

// =================================================================================================
// DeployTimelock -- the Foundry deploy script for the value-tiered outbound bridge time-lock
// {TimelockGuard} (design "2b.2 Outbound (hub -> spoke) is the RISKY direction").
//
// The guard is YOUR OWN contract (it composes with the mandate by address + holds no funds), so --
// unlike the money-bearing CCIP legs -- it is fully deployable + demoable on the 0G Galileo TESTNET
// (16602) at $0. It targets 0G only and REFUSES any other chain (see {WrongChain}), so the guard can
// never be deployed to an unintended network by accident (design SS8: testnet/dev only for live legs).
//
// THE EXACT OPERATOR COMMAND (deploys to Galileo TESTNET 16602 at $0):
//
//   set -a; . ./.env; set +a                          # OG_RPC_TESTNET / demo wallet from the .env
//   TIMELOCK_OWNER=<demo-wallet> TIMELOCK_AGENT=<demo-wallet> \
//   TIMELOCK_MANDATE=<deployed MandateRegistryV3 addr> \   # the gate the queue composes with
//   TIMELOCK_THRESHOLD=1000000 \                       # <= 1.0M is small (short delay); > is big (long)
//   TIMELOCK_SHORT_DELAY=3600 TIMELOCK_LONG_DELAY=86400 \  # 1h short / 24h-style long lock
//   OG_RPC=$OG_RPC_TESTNET \
//   forge script script/DeployTimelock.s.sol:DeployTimelock --rpc-url og --broadcast --private-key $PRIVATE_KEY
//
// After a confirmed broadcast, pin the deployed address into proofagent.toml [timelock_guard].address
// (claim only what's live -- design SS8). The deployer's PRIVATE_KEY is supplied to `forge script` via
// the CLI/env and is NEVER read or printed by this contract.
// =================================================================================================

/// @dev Minimal inline cheatcode interface -- the repo vendors NO external Solidity libraries
///      (clean-room / offline-by-default, design SS3 principle 6 / SS6).
interface IVm {
    function envAddress(string calldata name) external view returns (address);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @title DeployTimelock -- deploy {TimelockGuard} on 0G (design "2b.2", the outbound time-lock).
contract DeployTimelock {
    IVm internal constant VM = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice 0G Aristotle mainnet chain id (proofagent.toml [chain].id).
    uint256 internal constant OG_MAINNET_CHAIN_ID = 16661;
    /// @notice 0G Galileo testnet chain id (proofagent.toml [chain].testnet).
    uint256 internal constant OG_TESTNET_CHAIN_ID = 16602;

    /// @dev Reverts if the active chain is neither 0G mainnet nor 0G testnet -- the on-chain half of
    ///      design SS8 (target 0G only).
    error WrongChain(uint256 actual);

    /// @notice Deploy {TimelockGuard} to 0G with all parameters drawn from the environment. Guards the
    ///         active chain id FIRST.
    /// @return guard The freshly-deployed time-lock (its address is logged by `forge script`).
    function run() external returns (TimelockGuard guard) {
        // (0) Chain guard -- target 0G only (design SS8).
        requireOgChain(block.chainid);

        address owner = VM.envAddress("TIMELOCK_OWNER");
        address agent = VM.envAddress("TIMELOCK_AGENT");
        address mandate = VM.envAddress("TIMELOCK_MANDATE");
        uint256 threshold = VM.envOr("TIMELOCK_THRESHOLD", uint256(0));
        uint256 shortDelay = VM.envOr("TIMELOCK_SHORT_DELAY", uint256(0));
        uint256 longDelay = VM.envOr("TIMELOCK_LONG_DELAY", uint256(0));

        VM.startBroadcast();
        guard = new TimelockGuard(owner, agent, IMandateGate(mandate), threshold, shortDelay, longDelay);
        VM.stopBroadcast();
    }

    /// @notice Target-chain guard: reverts with {WrongChain} unless `chainId` is 0G mainnet (16661) or
    ///         0G testnet (16602). Pure + self-contained so the safety invariant is unit-testable.
    function requireOgChain(uint256 chainId) public pure {
        if (chainId != OG_MAINNET_CHAIN_ID && chainId != OG_TESTNET_CHAIN_ID) {
            revert WrongChain(chainId);
        }
    }
}
