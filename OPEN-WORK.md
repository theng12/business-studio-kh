# Open work — business-studio-kh

Open tasks and known defects for this repository only; updated in the same commit whenever work starts, changes, or closes.

- [ ] **Sparkle install-and-relaunch is not proven end to end** — 0.1.127 fixed the update check starting (it now waits for the hold listener and retries a refused hold 3× with 1 s/3 s backoff), and the order is proven in that release's gate; what is unexercised is the last step, where Sparkle installs and relaunches the host, because it terminates and relaunches with no arguments and would open the default data folder. Deferred by the owner on 2026-11-25 as non-blocking (*"none of this is a blocker"*), so it is accepted, not passed. Issue row `20261125-28`. **Next:** with the owner's go for one visible window, run it against a throwaway data folder and record the before/after versions and the relaunch line.
