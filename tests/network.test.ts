import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { pickLanAddresses } from '../server/index.js';

const v4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  internal,
  family: 'IPv4',
  netmask: '255.255.255.0',
  mac: '00:00:00:00:00:00',
  cidr: `${address}/24`,
});

describe('pickLanAddresses', () => {
  it('prioriza el hotspot de Windows y deja al final los adaptadores virtuales', () => {
    const result = pickLanAddresses({
      'Ethernet 2 (VirtualBox Host-Only Network)': [v4('192.168.56.1')],
      'Wi-Fi': [v4('192.168.2.158')],
      'Conexión de área local* 2': [v4('192.168.137.1')],
      'vEthernet (WSL)': [v4('172.20.16.1')],
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
    });
    expect(result).toEqual(['192.168.137.1', '192.168.2.158', '192.168.56.1', '172.20.16.1']);
  });

  it('usa la red del router cuando no hay hotspot e ignora IPv6 y link-local', () => {
    const result = pickLanAddresses({
      en0: [
        { ...v4('fe80::1'), family: 'IPv6', scopeid: 1 } as NetworkInterfaceInfo,
        v4('10.0.0.23'),
      ],
      en5: [v4('169.254.10.2')],
    });
    expect(result).toEqual(['10.0.0.23']);
  });

  it('devuelve lista vacía si no hay red', () => {
    expect(pickLanAddresses({ lo: [v4('127.0.0.1', true)] })).toEqual([]);
  });
});
