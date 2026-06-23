// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

import {Deploy} from "../script/Deploy.s.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";

/// @dev Minimal inline cheatcode interface -- the repo vendors NO forge-std (clean-room /
///      offline-by-default, design SS6). The tests declare only the cheatcodes they use: `chainId`
///      (drive `block.chainid` to exercise the 0G target-chain guard) and `setEnv` (provide the
///      deploy params {run} reads from the environment). The address is Foundry's well-known
///      cheatcode address, derived from keccak256("hevm cheat code").
interface IVm {
    function chainId(uint256 newChainId) external;
    function setEnv(string calldata name, string calldata value) external;
}

/// @title DeployTest -- dependency-free tests for the {Deploy} script (design SS4 / build spec CS2).
/// @notice Proves the script is BUILT and SOUND without performing any live deploy (design SS8:
///         claim only what's live). Covers the target-chain guard (the on-chain half of "testnet/dev
///         only for live legs") and an end-to-end happy-path deploy under a 0G chain id with the
///         params drawn from the environment exactly as `run()` reads them.
contract DeployTest {
    IVm internal constant VM = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    Deploy internal script;

    // Fixed actors / params (deterministic; design SS3 principle 4).
    address internal constant OWNER = address(0xA11CE);
    address internal constant AGENT = address(0xA6E47);
    uint256 internal constant OG_MAINNET = 16661; // 0G Aristotle
    uint256 internal constant OG_TESTNET = 16602; // 0G Galileo
    uint256 internal constant PER_TX_CAP = 2_000_000; // $2 on a 6-decimal token, MINOR units

    function setUp() public {
        script = new Deploy();
    }

    // --- internal assertion helpers (no forge-std) ----------------------------------------------

    function _assertTrue(bool cond, string memory why) internal pure {
        require(cond, why);
    }

    // --------------------------------------------------------------------------------------------
    // Target-chain guard (design SS8) -- the script accepts ONLY the two 0G chain ids and rejects
    // everything else with {Deploy.WrongChain}. This is CS2's load-bearing safety invariant.
    // --------------------------------------------------------------------------------------------

    function test_ChainGuard_AcceptsOgMainnet() public view {
        // Must not revert for 0G Aristotle (16661).
        script.requireOgChain(OG_MAINNET);
    }

    function test_ChainGuard_AcceptsOgTestnet() public view {
        // Must not revert for 0G Galileo (16602).
        script.requireOgChain(OG_TESTNET);
    }

    function test_ChainGuard_RejectsForeignChain() public view {
        // A non-0G chain (e.g. Foundry's default 31337) must revert with WrongChain.
        (bool ok, bytes memory data) =
            address(script).staticcall(abi.encodeWithSelector(Deploy.requireOgChain.selector, uint256(31337)));
        _assertTrue(!ok, "requireOgChain must revert for a non-0G chain id");
        // The revert payload must be WrongChain(31337) -- selector + the offending chain id.
        bytes4 sel = bytes4(keccak256("WrongChain(uint256)"));
        _assertTrue(data.length == 4 + 32, "revert payload must be WrongChain(uint256)");
        bytes4 got;
        uint256 actual;
        assembly {
            got := mload(add(data, 0x20))
            actual := mload(add(data, 0x24))
        }
        _assertTrue(got == sel, "revert selector must be WrongChain(uint256)");
        _assertTrue(actual == 31337, "WrongChain must carry the offending chain id");
    }

    function test_ChainGuard_RejectsZeroChain() public view {
        (bool ok,) =
            address(script).staticcall(abi.encodeWithSelector(Deploy.requireOgChain.selector, uint256(0)));
        _assertTrue(!ok, "requireOgChain must reject chain id 0");
    }

    // --------------------------------------------------------------------------------------------
    // End-to-end deploy -- under a 0G chain id, with params from the env, `run()` deploys a live,
    // correctly-parameterised {MandateRegistry}. Proves the env wiring + constructor plumbing without
    // any network (the cheatcodes set chain + env in-process; the deploy is a local in-EVM create).
    // --------------------------------------------------------------------------------------------

    /// @dev Render an `address` as its lowercase `0x`-prefixed 40-hex-digit string, so the test can
    ///      feed the SAME actor constants {run} will read back via `envAddress` -- no brittle hand-
    ///      checksummed literals. `envAddress` parses the value at runtime (case-insensitive), so a
    ///      lowercase form round-trips exactly.
    function _addrToString(address a) internal pure returns (string memory) {
        bytes memory hexchars = "0123456789abcdef";
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        uint160 v = uint160(a);
        for (uint256 i = 0; i < 20; i++) {
            // Safe: `>> (8*(19-i))` then narrow to the low byte -- masking to one byte is the intent.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 b = uint8(v >> (8 * (19 - i)));
            out[2 + i * 2] = hexchars[b >> 4];
            out[3 + i * 2] = hexchars[b & 0x0f];
        }
        return string(out);
    }

    /// @notice End-to-end deploy, BOTH the parameterised and the safe-default env paths, in ONE test.
    /// @dev    The two env scenarios are exercised sequentially in a single test body ON PURPOSE: the
    ///         `setEnv` cheatcode mutates the SHARED OS process environment, so splitting them into two
    ///         tests would let them race on the same `MANDATE_*` keys under Foundry's parallel runner.
    ///         Running them in-order here makes the env state deterministic (design SS3 principle 4).
    function test_Run_DeploysFromEnv_ParameterisedAndSafeDefaults() public {
        // (A) Parameterised path on the TESTNET (design SS8: testnet first) -- concrete cap + expiry.
        VM.chainId(OG_TESTNET);
        VM.setEnv("MANDATE_OWNER", _addrToString(OWNER));
        VM.setEnv("MANDATE_AGENT", _addrToString(AGENT));
        VM.setEnv("MANDATE_PER_TX_CAP", "2000000");
        VM.setEnv(
            "MANDATE_EXPIRY",
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        );

        MandateRegistry reg = script.run();
        _assertTrue(reg.owner() == OWNER, "owner must be the env MANDATE_OWNER");
        _assertTrue(reg.agent() == AGENT, "agent must be the env MANDATE_AGENT");
        _assertTrue(reg.perTxCap() == PER_TX_CAP, "per-tx cap must be the env MANDATE_PER_TX_CAP");
        _assertTrue(reg.expiry() == type(uint256).max, "expiry must be the env MANDATE_EXPIRY (never)");
        _assertTrue(reg.paused() == false, "a freshly-deployed mandate is not paused");

        // (B) Safe-default path on MAINNET -- the optional knobs left empty -> deny-by-default cap +
        //     never-expire. Same process, set AFTER (A) so the empty values are the live env state.
        VM.chainId(OG_MAINNET);
        VM.setEnv("MANDATE_PER_TX_CAP", "");
        VM.setEnv("MANDATE_EXPIRY", "");

        MandateRegistry def = script.run();
        // Default per-tx cap 0 == "permits nothing until the owner sets a real cap" (safe by construction).
        _assertTrue(def.perTxCap() == 0, "default per-tx cap must be 0 (deny-by-default)");
        // Default expiry == never expires.
        _assertTrue(def.expiry() == type(uint256).max, "default expiry must be type(uint256).max (never)");
    }
}
