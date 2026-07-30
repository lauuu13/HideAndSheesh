import { registerPlugin } from '@capacitor/core';

const HostServer = registerPlugin('HostServer', {
  web: () => import('./web.js').then((m) => new m.HostServerWeb())
});

export default HostServer;
