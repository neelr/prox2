import { NextApiRequest, NextApiResponse } from "next";

import emojis from 'emojis-keywords';
import { Block, KnownBlock } from "@slack/web-api";

import { api_config, failRequest, sameUser, setupMiddlewares, succeedRequest, table, TableRecord, verifySignature, viewConfession, web } from "../../lib/main";
import { confessions_channel } from "../../lib/secrets_wrapper";

export const config = api_config;

interface BlockActionInteraction {
    type: 'block_actions';
    trigger_id: string;
    response_url: string;
    user: string;
    message: {
        type: 'message';
        text: string;
        ts: string;
    };
    actions: {
        block_id: string;
        action_id: string;
        value: string;
    }[];
    token?: string;
    hash: string;
}

interface MessageActionInteraction {
    type: 'message_action';
    callback_id: string;
    trigger_id: string;
    response_url: string;
    user: {
        id: string;
    };
    message: {
        type: 'message';
        text: string;
        ts: string;
        thread_ts?: string;
    };
    channel: {
        id: string;
    };
    token?: string;
}

interface ViewSubmissionInteraction {
    type: 'view_submission';
    user: {
        id: string;
    };
    view: {
        callback_id: string;
        blocks: (Block | KnownBlock)[];
        state: {
            values: {
                [key: string]: {
                    [input: string]: {
                        type: 'plain_text_input';
                        value: string;
                    } | {
                        type: 'external_select';
                        selected_option: {
                            value: string;
                        };
                    };
                };
            };
        };
    };
}

interface BlockSuggestionInteraction {
    type: 'block_suggestion';
    action_id: 'emoji';
    block_id: 'emoji';
    value: string;
}

type SlackInteractionPayload = MessageActionInteraction | ViewSubmissionInteraction | BlockSuggestionInteraction | BlockActionInteraction & {
    type: string;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    await setupMiddlewares(req, res);

    console.log(`Interaction!`);
    console.log(`Validating signature...`);
    const isValid = verifySignature(req);
    if (!isValid) {
        console.log(`Invalid!`);
        res.writeHead(400).end();
        return;
    }
    console.log(`Valid!`);
    const data = JSON.parse((req.body as { payload: string }).payload) as SlackInteractionPayload;
    console.log(`Type = ${data.type}`);
    if (data.type == 'block_actions') {
        console.log(`Block action!`);
        if (data.actions.length > 0) {
            const action = data.actions[0];
            try {
                if (action.value == 'approve') {
                    console.log(`Approval of message ts=${data.message.ts}`);
                    await viewConfession(data.message.ts, true);
                } else if (action.value == 'disapprove') {
                    console.log(`Disapproval of message ts=${data.message.ts}`);
                    await viewConfession(data.message.ts, false);
                } else {
                    console.log(`Unknown value ${action.value}`);
                }
            } catch (e) {
                await failRequest(data.response_url, e);
                res.writeHead(500).end();
                return;
            }
        } else {
            console.log(`No action found`);
        }
    } else if (data.type == 'block_suggestion') {
        console.log(`Block suggestion!`);
        // Enumerate emojis to build select box
        let emojis_list = emojis;
        const custom_emojis = await web.emoji.list();
        if (!custom_emojis.ok) throw `Failed to fetch custom emoji`;
        emojis_list = [...emojis_list, ...Object.keys(custom_emojis.emoji as { [emoji: string]: string }).map(x => `:${x}:`)];
        emojis_list = emojis_list.filter(emoji => emoji.startsWith(data.value)).slice(0, 100);
        res.json({
            options: emojis_list.map(emoji => {
                return {
                    text: {
                        type: 'plain_text',
                        text: emoji,
                        emoji: true
                    },
                    value: emoji
                }
            })
        });
        console.log(`Request success`);
        return;
    } else if (data.type == 'message_action') {
        console.log(`Message action!`);
        try {
            if (data.channel.id != confessions_channel) {
                throw 'Invalid channel ID';
            }
            if (data.callback_id == 'reply_anonymous') {
                // try to fetch record
                const records = await (await table.select({
                    filterByFormula: `{published_ts} = ${data.message.ts}`
                })).firstPage();
                if (records.length != 1) {
                    throw `Failed to find single record with published_ts=${data.message.ts}, got ${records.length}`;
                }
                const record = records[0];
                const fields = record.fields as TableRecord;

                // Check user...
                if (!sameUser(fields, data.user.id)) {
                    await succeedRequest(data.response_url,
                        'You are not the original poster of the confession, so you cannot reply anonymously.');
                    res.writeHead(200).end();
                    return;
                }

                const resp = await web.views.open({
                    trigger_id: data.trigger_id,
                    view: {
                        callback_id: `reply_modal_${fields.published_ts}`,
                        type: 'modal',
                        title: {
                            type: 'plain_text',
                            text: `Replying to #${fields.id}`
                        },
                        submit: {
                            type: 'plain_text',
                            text: 'Reply',
                            emoji: true
                        },
                        close: {
                            type: 'plain_text',
                            text: 'Cancel',
                            emoji: true
                        },
                        blocks: [
                            {
                                type: 'input',
                                block_id: 'reply',
                                element: {
                                    type: 'plain_text_input',
                                    multiline: true,
                                    action_id: 'confession_reply'
                                },
                                label: {
                                    type: 'plain_text',
                                    text: 'Reply',
                                    emoji: true
                                }
                            }
                        ]
                    }
                });
                if (!resp.ok) {
                    throw 'Failed to open modal';
                }
            } else if (data.callback_id == 'react_anonymous') {
                // try to fetch record
                const records = await (await table.select({
                    filterByFormula: `OR({published_ts} = '${data.message.ts}', {published_ts} = '${data.message.thread_ts}')`
                })).firstPage();
                if (records.length != 1) {
                    throw `Failed to find single record with published_ts=${data.message.ts}, got ${records.length}`;
                }
                const record = records[0];
                const fields = record.fields as TableRecord;

                // Check user...
                if (!sameUser(fields, data.user.id)) {
                    await succeedRequest(data.response_url,
                        'You are not the original poster of the confession, so you cannot react anonymously.');
                    res.writeHead(200).end();
                    return;
                }

                const modal_res = await web.views.open({
                    trigger_id: data.trigger_id,
                    view: {
                        type: 'modal',
                        callback_id: `react_modal_${fields.published_ts}_${data.message.ts}`,
                        title: {
                            type: 'plain_text',
                            text: `Reacting to #${fields.id}`,
                            emoji: true
                        },
                        submit: {
                            type: 'plain_text',
                            text: 'React',
                            emoji: true
                        },
                        close: {
                            type: 'plain_text',
                            text: 'Cancel',
                            emoji: true
                        },
                        blocks: [
                            {
                                type: 'section',
                                block_id: 'emoji',
                                text: {
                                    type: 'plain_text',
                                    text: 'Pick an emoji to react with'
                                },
                                accessory: {
                                    type: 'external_select',
                                    placeholder: {
                                        type: 'plain_text',
                                        text: 'Select an emoji'
                                    },
                                    action_id: 'emoji',
                                    min_query_length: 4
                                }
                            }
                        ]
                    }
                });
                if (!modal_res.ok) throw `Failed to open modal`;
            } {
                console.log(`Unknown callback ${data.callback_id}`);
            }
        } catch (e) {
            await failRequest(data.response_url, e);
            res.writeHead(500).end();
            return;
        }
    } else if (data.type == 'view_submission') {
        console.log(`View submission!`);
        try {
            if (data.view.callback_id.startsWith('reply_modal')) {
                const published_ts_res = /^reply_modal_(.*)$/.exec(data.view.callback_id);
                if (!published_ts_res) throw 'Failed to exec regex';
                const published_ts = published_ts_res[1];
                if (!published_ts) throw 'Failed to get regex group';

                // try to fetch record
                const records = await (await table.select({
                    filterByFormula: `{published_ts} = ${published_ts}`
                })).firstPage();
                if (records.length != 1) {
                    throw `Failed to find single record with published_ts=${published_ts}, got ${records.length}`;
                }
                const record = records[0];
                const fields = record.fields as TableRecord;

                // Check user...
                if (!sameUser(fields, data.user.id)) {
                    // update view
                    res.json({
                        response_action: 'update',
                        view: {
                            callback_id: `reply_modal_${fields.published_ts}`,
                            type: 'modal',
                            title: {
                                type: 'plain_text',
                                text: `Replying to #${fields.id}`
                            },
                            submit: {
                                type: 'plain_text',
                                text: 'Reply',
                                emoji: true
                            },
                            close: {
                                type: 'plain_text',
                                text: 'Cancel',
                                emoji: true
                            },
                            blocks: [
                                {
                                    type: 'input',
                                    block_id: 'reply',
                                    element: {
                                        type: 'plain_text_input',
                                        multiline: true,
                                        action_id: 'confession_reply'
                                    },
                                    label: {
                                        type: 'plain_text',
                                        text: 'Reply',
                                        emoji: true
                                    }
                                },
                                {
                                    type: 'section',
                                    text: {
                                        type: 'mrkdwn',
                                        text: 'Failed to reply: \
*You are not the original poster of the confession, so cannot reply anonymously.*',
                                    }
                                }
                            ]
                        }
                    });
                    return;
                    // throw `Different user, cannot reply!`;
                }

                // quick assert for typeck
                if (data.view.state.values.reply.confession_reply.type != 'plain_text_input') return;

                // Reply in thread
                const r = await web.chat.postMessage({
                    channel: confessions_channel,
                    text: data.view.state.values.reply.confession_reply.value,
                    thread_ts: published_ts
                });
                if (!r.ok) throw `Failed to reply in thread`;
            } else if (data.view.callback_id.startsWith('react_modal')) {
                const published_ts_res = /^react_modal_(.*)_(.*)$/.exec(data.view.callback_id);
                if (!published_ts_res) throw 'Failed to exec regex';
                const [published_ts, thread_ts] = [published_ts_res[1], published_ts_res[2]];
                if (!published_ts || !thread_ts) throw 'Failed to get regex group';

                // try to fetch record
                const records = await (await table.select({
                    filterByFormula: `{published_ts} = ${published_ts}`
                })).firstPage();
                if (records.length != 1) {
                    throw `Failed to find single record with published_ts=${published_ts}, got ${records.length}`;
                }
                const record = records[0];
                const fields = record.fields as TableRecord;

                // Check user...
                if (!sameUser(fields, data.user.id)) {
                    // update view
                    res.json({
                        response_action: 'update',
                        view: {
                            ...data.view,
                            blocks: [
                                ...data.view.blocks,
                                {
                                    type: 'section',
                                    text: {
                                        type: 'mrkdwn',
                                        text: 'Failed to react: \
*You are not the original poster of the confession, so cannot react anonymously.*',
                                    }
                                }
                            ]
                        }
                    } as {
                        response_action: 'update';
                        view: {
                            blocks: (Block | KnownBlock)[];
                        };
                    });
                    return;
                    // throw `Different user, cannot reply!`;
                }

                // quick assert for typeck
                if (data.view.state.values.emoji.emoji.type != 'external_select') return;

                // React to message
                const react_res = await web.reactions.add({
                    name: data.view.state.values.emoji.emoji.selected_option.value.replace(/\:/g, ''),
                    channel: confessions_channel,
                    timestamp: thread_ts
                });
                if (!react_res.ok) throw `Failed to react`;
            }
        } catch (e) {
            console.log(e);
            res.writeHead(500).end();
            return;
        }
    }
    console.log(`Request success`);
    res.writeHead(204).end();
}