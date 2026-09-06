"""Fresh Hermes-owned device login. Never import another application's refresh token."""

from probe import ROOT, configure_probe_home, verify_pin


def main():
    verify_pin()
    home = ROOT / "data/compat/hermes-auth"
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    if (home / "auth.json").exists():
        raise SystemExit("Hermes compatibility login already exists; use the probe to verify refresh.")
    configure_probe_home(home)
    from hermes_cli.auth_codex import _codex_device_code_login, _save_codex_tokens
    tokens = _codex_device_code_login()
    _save_codex_tokens(tokens)
    print("Hermes-owned subscription login saved in the ignored compatibility profile.")


if __name__ == "__main__":
    main()
