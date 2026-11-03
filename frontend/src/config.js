/** The one ClauseGuard deployment this console talks to.
 *
 * Written by `scripts/deploy.py` (the "Deploy Contract" workflow), never at
 * runtime: visitors read and write this single contract and cannot deploy their
 * own. `CONTRACT_REVISION` is the hash of the contract source that deployment
 * was built from; when it differs from the code in contracts/, the workflow
 * deploys a fresh contract and updates both values.
 *
 * An empty address means no deployment has been recorded yet, and the console
 * falls back to its local simulation so the screens still work.
 */
export const CONTRACT_ADDRESS = "0x72900639955909D65cE637d50fb33fc9d4DcE75F";
export const CONTRACT_REVISION = "3e6ace8aebbb";
