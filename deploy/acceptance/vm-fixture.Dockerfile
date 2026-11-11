# A made-up machine for the full tester's machine job scenarios (ADR-0231): Debian with an SSH server that accepts keys
# only, a login "nocheh" whose shell is bash, and procps, so a stopped job's cleanup can end that login's programs. It
# holds no key: a scenario adds the machine's public key the way the owner would, and each start makes new host keys.
FROM python:3.14.10-slim-trixie@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server procps && rm -rf /var/lib/apt/lists/* && \
    rm -f /etc/ssh/ssh_host_* && mkdir -p /run/sshd && \
    useradd --create-home --shell /bin/bash --password '*' nocheh && \
    install -d -m 0700 -o nocheh -g nocheh /home/nocheh/.ssh && \
    install -m 0600 -o nocheh -g nocheh /dev/null /home/nocheh/.ssh/authorized_keys && \
    printf '%s\n' 'Port 22' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' 'UsePAM no' \
      'AllowUsers nocheh' 'X11Forwarding no' 'PrintMotd no' > /etc/ssh/sshd_config.d/fixture.conf
EXPOSE 22
CMD ["sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e"]
