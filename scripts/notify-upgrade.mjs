import {Store} from '../dist/src/storage/store.js';
import {NotificationManager} from '../dist/src/notifications/outbox.js';
import {MockWeChat} from '../dist/src/channels/wechat/mock.js';
// Enqueue only. The running REAL service owns transport and credential access.
const store=new Store('data/bridge.sqlite');
const outbox=new NotificationManager(store,new MockWeChat());
const id=outbox.enqueue('已经更新好了。以后直接像平时聊天一样说就行，比如“现在在忙什么？”“明天下午三点提醒我交报告”。如果时间或项目不明确，我会接着问你，不用记指令。','natural-language-upgrade-v0.1');
console.log(JSON.stringify({queued:!!id}));store.close();
