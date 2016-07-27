const slack = require('slack');
const debug = require('debug')('retrobot');
const dict = require('./dict');

const stop = 'stop';
const start = 'start';
const aliases = {
  stop,
  end: stop,
  fin: stop,
  finish: stop,
  start,
  record: start,
  begin: start,
};

Object.keys(dict).forEach(_ => aliases[_] = dict[_]);

let bot = slack.rtm.client();
const token = process.env.SLACK_TOKEN;
let inRetro = false;
let guid = 0;

let dms = {};

let channel = null;
const retrospective = {
  plus: [],
  minus: [],
};

module.exports = {
  flushRetrospective,
  setup,
  captureRetrospective,
  command,
  isDM,
  reply,
  isToBot,
};

if (!module.parent) {
  setup();
}

function setup(callback) {
  bot.listen({ token });

  // get the id of the bot
  bot.started(data => {
    debug('started');
    bot.self = { id: data.self.id, name: data.self.name };
    data.channels.filter(_ => _.is_member).map(channel => {
      // reply({ channel: channel.id }, `:wave: hey, I'm back online`);
    });
    console.log('connected', bot.self);
    if (callback) {
      callback(bot);
    }
  });

  bot.message(message => {
    debug('message');
    if (message.user === bot.self.id) {
      return;
    }

    let text = (message.text || '').trim();
    if (!text) {
      debug('message empty');
      return;
    }

    if (!inRetro) {
      if (isDM(message)) {
        // debug('> got message whilst not in retro');
        if (message.reply_to) {
          return; // ignore
        }
        debug('> got a DM: %s', message.text);
        return notInRetro(message);
      }

      if (!isToBot(text)) {
        return;
      }
    }

    if (isDM(message)) {
      debug('> got retrospective message: %s', message.text);
      // capture the rerto data
      return captureRetrospective(message);
    } else if (isToBot(text)) {
      debug('> got potential command: %s', message.text);
      // else we're in the retro, parse the data
      return command(message);
    }
  });
}

function captureRetrospective(message) {
  const lines = message.text.split('\n');
  const types = {
    '+': 'plus',
    '-': 'minus',
  };

  lines.map(_ => _.trim()).forEach(line => {
    debug('got "%s" in retro line', line[0]);
    const type = types[line[0]];
    if (type) {
      return retrospective[type].push(line.slice(1).trim() + ` – <@${message.user}>`);
    }

    reply(message, `I've ignored \`${line}\` only because it didn't start with a \`+/-\``);
  });
}

function notInRetro(message) {
  const text = 'The retrospective isn\'t runnning at the moment. Here, have ' +
    'some wine whilst you wait for it to start 🍷';

  reply(message, text);
}

function isDM(message) {
  return message.channel[0] === 'D';
}

function command(message) {
  let [me, cmd, ...rest] = message.text.split(' ');
  cmd = cmd.toLowerCase().replace(/\W/g, '');

  debug('command: %s', cmd);

  if (!aliases[cmd]) {
    return reply(message, ':thinking_face:☔️ nope, does not compute. The upshot though, I do support `start` and `stop`, try those instead ⛅️');
  }

  if (aliases[cmd] === start) {
    // TODO check and flush
    inRetro = true;
    // check if we should auto end?
    const autoend = rest.shift();
    let msg = '🔔 Retrospective is now recording';

    if (autoend) {
      msg += ', and will auto end in ' + autoend;
      setTimeout(() => {
        stopRetro(message);
      }, parseTiming(autoend));
    }

    reply(message, msg);
    channel = message.channel;
    debug('getting list of members in %s', channel);
    slack.channels.info({ token, channel }, (error, data) => {
      let members = data.channel.members || [];
      members.filter(user => user !== bot.self.id).map(user => {
        // also check if the user is a) active, b) not DND
        slack.dnd.info({ token, user }, (error, dnd) => {
          if (dnd.dnd_enabled) {
            const now = Date.now() / 1000;

            // check if the user is currently inside of a DND status
            if (dnd.next_dnd_start_ts < now && now < dnd.next_dnd_end_ts) {
              return;
            }
          }

          slack.users.getPresence({ token, user }, (error, presence) => {
            // only pin active users
            if (presence.presence === 'away') {
              return;
            }
            slack.im.open({ token, user }, (error, data) => {
              if (error) {
                debug('error opening IM', error);
                return;
              }

              dms[user] = data.channel.id;
              reply({ channel: dms[user] }, '👂 Tell me about your retrospective' +
                '\nStart lines with `+` for "worked well" and `-` for "needs ' +
                'improvement".');
            });
          });

        });
      });
    });
  } else if (aliases[cmd] === stop) {
    stopRetro(message);
  } else if (aliases[cmd]) {
    return reply(message, aliases[cmd]);
  }


}

function stopRetro(message) {
  if (inRetro === false) {
    return reply(message, 'The retrospective finished already. I don\'t have a historical record of the retro to print here anyway. Sorry. Have some tea 🍵');
  }
  inRetro = false;
  reply(message, 'The retrospective has now finished, give me a second or ' +
    'two to gather everyone\'s feedback and post it here grouped by ' +
    '"worked well" and "needs improvement"…');

  let msg = `⏰ time's up! The retrospective is over, head on back to <#${channel}>`;
  Object.keys(dms).map(user => {
    reply({ channel: dms[user] }, msg);
  });

  // setTimeout used for...fun really.
  setTimeout(flushRetrospective.bind(null, retrospective), Math.random() * 3000 + 1000 | 0);
}

function flushRetrospective(retrospective) {
  shuffleArray(retrospective.plus);
  shuffleArray(retrospective.minus);

  debug('flushing retrospective (plus: %s, minus: %s)', retrospective.plus.length, retrospective.minus.length);

  let source = { channel: channel || bot.self.channel };

  let messages = [];

  messages.push(`*Below is the "worked well" list, good work team 👍*`);
  retrospective.plus.map((line, i) => {
    messages.push(`${i + 1}. ${line}`);
  });

  messages.push(`*Below is the "needs work" list, 🌱*`);
  retrospective.minus.map((line, i) => {
    messages.push(`${i + 1}. ${line}`);
  });

  messages.push(`\n*Please go ahead and use 👍 to indicate that you think a particular item should become an action item for the next sprint.*\n\nSee you after the next sprint 👋🔌`);

  retrospective = { plus: [], minus: [] };

  flushMessages(source, messages);
}

function flushMessages(source, messages) {
  reply(source, messages.shift(), () => {
    if (messages.length) {
      flushMessages(source, messages);
    }
  });

}

function shuffleArray(array) {
  // cheap randomise
  array.sort(() => Math.random() + 0.5 > 1 ? 1 : -1);
}

function reply(source, message, callback = () => {}) {
  debug('< sending: ' + message);
  guid++;
  slack.chat.postMessage({
    guid,
    token,
    channel: source.channel,
    text: message,
    as_user: true,
  }, callback);
}

function isToBot(message) {
  if (message.indexOf(`<@${bot.self.id}>`) === 0) {
    return true;
  }

  if (message.indexOf(`${bot.self.name}:`) === 0) {
    return true;
  }

  return false;
}

function mentionsBot(message) {
  if (message.indexOf(`<@${bot.self.id}>`) !== -1) {
    return true;
  }

  if (message.indexOf(` ${bot.self.name} `) !== -1) {
    return true;
  }

  return false;
}

function parseTiming(t) {
  (t + '').replace(/.*?([hms]+).*/, function (all, match) {
    var n = all.replace(new RegExp(match), '') * 1;

    if (match === 'ms') {
      // do nothing
    } else if (match === 's') {
      n *= 1000;
    } else if (match === 'm') {
      n *= 60 * 1000;
    } else if (match === 'h') {
      n *= 60 * 60 * 1000;
    }

    t = n;
  });

  return t;
}

// listen for a message to me
// handle commands: start, stop, help
// on('start') ->
//   - reset retrospective (check if flushed or not)
//   - list all the members of the channel that are active
//   - send each on an IM with the summary help
//   - add all messages to appropriate arrays
//   - handle any errors (prefix needs +/-)
// on('stop') ->
//   - print each message to the channel the start was initiatied from
//   - set flag saying printed
