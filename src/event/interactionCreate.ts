import { CommandManager, EmbedUtility, GuildUtility, VerificationUtility } from '..';
import { TypedEvent } from '../base/clientEvent';
import { VerificationTicket } from '../database';
import config from '../config';
import {
  ButtonInteraction,
  Client,
  Collection,
  CollectorFilter,
  CommandInteraction,
  GuildMember,
  Interaction,
  Message,
  MessageEmbed,
  Snowflake,
  TextBasedChannel,
  User
} from 'discord.js';

const questionAskCollection = new Collection<Snowflake, User>();
const verificationCollection = new Collection<User, boolean>();

function transformMessage(message: Message): string {
  return `${message.content}${message.attachments.size > 0 ? '\n\n' : ''}${Array.from(message.attachments.values())
    .map((attachment, index) => `[Attachment ${index + 1}](${attachment.proxyURL})`)
    .join('\n')}`;
}

async function handleQuestion(
  textChannel: TextBasedChannel,
  filter?: CollectorFilter<[Message<boolean>]>
): Promise<Message | void> {
  const message = await textChannel.awaitMessages({
    max: 1,
    filter,
    time: 180000,
    errors: ['time']
  });
  const response = message.first();
  if (!response) return;
  if (response.content.toLowerCase().trim() === 'cancel') return;
  return response;
}

export default TypedEvent({
  eventName: 'interactionCreate',
  on: async (client: Client, interaction: Interaction) => {
    if (!interaction.member || !(interaction.member instanceof GuildMember)) return;
    if (interaction.isButton()) {
      const buttonInteraction = interaction as ButtonInteraction;

      let moderator: GuildMember | void;
      let ticket: VerificationTicket | void;
      let verificationMessage: Message | void;

      // Check for permission, set fields and set up
      switch (buttonInteraction.customId) {
        case 'verify_accept':
        case 'verify_decline':
        case 'verify_ticket': {
          await buttonInteraction.deferReply();
          moderator = await GuildUtility.getGuildMember(buttonInteraction.user.id);
          if (!moderator) throw new Error("This wasn't suppose to happened");
          if (!GuildUtility.isModerator(moderator))
            return buttonInteraction.editReply({
              embeds: [EmbedUtility.USER_TITLE(EmbedUtility.NO_PERMISSION(), buttonInteraction.user)]
            });

          ticket = await VerificationUtility.getTicketFromMessageId(buttonInteraction.message.id);
          if (!ticket)
            return buttonInteraction.editReply({
              embeds: [EmbedUtility.USER_TITLE(EmbedUtility.CANT_FIND_TICKET(), buttonInteraction.user)]
            });

          if (ticket) verificationMessage = await VerificationUtility.getMessageFromTicket(ticket);
          break;
        }
        case 'verify': {
          await buttonInteraction.deferReply({ ephemeral: true });
          break;
        }
        default: {
          await buttonInteraction.editReply({
            embeds: [
              EmbedUtility.ERROR_COLOR(
                EmbedUtility.USER_TITLE(
                  new MessageEmbed().setDescription(`No implementation for ${buttonInteraction.customId}!`),
                  buttonInteraction.user
                )
              )
            ]
          });
          break;
        }
      }

      // The actual logic
      switch (buttonInteraction.customId) {
        case 'verify_accept': {
          break;
        }
        case 'verify_decline': {
          if (questionAskCollection.has(verificationMessage!.id))
            return buttonInteraction.editReply({
              embeds: [
                EmbedUtility.USER_TITLE(
                  EmbedUtility.VERIFICATION_ALREADY_TAKEN(
                    new MessageEmbed({
                      footer: { text: ticket!.id }
                    }),
                    questionAskCollection.get(verificationMessage!.id)!
                  ),
                  buttonInteraction.user
                )
              ]
            });

          questionAskCollection.set(verificationMessage!.id, buttonInteraction.user);

          await buttonInteraction.editReply({
            embeds: [
              EmbedUtility.SUCCESS_COLOR(
                EmbedUtility.USER_TITLE(
                  new MessageEmbed({
                    description: "What's the reason for declining?",
                    footer: {
                      text: `${ticket!.id} | Respond within 5 minutes | Say 'cancel' to exit`
                    }
                  }),
                  buttonInteraction.user
                )
              )
            ]
          });

          const reason = await handleQuestion(
            GuildUtility.verificationLogChannel!,
            (responseMessage: Message) => responseMessage.author.id === buttonInteraction.user.id
          ).catch(() => {
            questionAskCollection.delete(verificationMessage!.id);
            buttonInteraction.followUp({
              embeds: [
                EmbedUtility.ERROR_COLOR(
                  EmbedUtility.USER_TITLE(EmbedUtility.DIDNT_RESPOND_IN_TIME(), buttonInteraction.user)
                )
              ]
            });
            return;
          });

          if (!reason) {
            questionAskCollection.delete(verificationMessage!.id);
            throw new Error("This shouldn't happened");
          }

          const user = await client.users.fetch(ticket!.senderId);
          if (user)
            try {
              user.send({
                embeds: [
                  EmbedUtility.ERROR_COLOR(
                    new MessageEmbed({
                      title: 'Sorry!',
                      description: `Your verification request has been declined by ${moderator}\nReason: ${transformMessage(
                        reason
                      )}`
                    })
                  )
                ]
              });
            } catch (ignored) {}

          await VerificationUtility.deleteTicket(ticket!, {
            deleteType: 'DECLINED',
            who: moderator!.user
          });

          await buttonInteraction.followUp({
            embeds: [
              EmbedUtility.SUCCESS_COLOR(
                EmbedUtility.USER_TITLE(
                  new MessageEmbed({
                    title: 'All done!',
                    description: `Ticket **${ticket!.id}** has been declined!`
                  }),
                  moderator!.user
                )
              )
            ]
          });

          break;
        }
        case 'verify_ticket': {
          break;
        }
        case 'verify': {
          if (verificationCollection.has(buttonInteraction.user))
            return buttonInteraction.editReply({ embeds: [EmbedUtility.ALREADY_IN_SESSION()] });

          verificationCollection.set(buttonInteraction.user, true);

          const dmChannel = interaction.user.dmChannel || (await interaction.user.createDM());

          try {
            await dmChannel.send({
              embeds: [
                EmbedUtility.SUCCESS_COLOR(
                  new MessageEmbed({
                    description:
                      'Before we can grant you access to the rest pf the server, we needs you to answer some questions. The answers will __**NOT**__ be used for any other purposes, please answer all the following questions with honesty. Thanks!'
                  })
                )
              ]
            });
          } catch (e: any) {
            if (e.code === 50007) return buttonInteraction.editReply({ embeds: [EmbedUtility.CANT_DM()] });
            else throw e;
          }

          buttonInteraction.editReply({
            embeds: [
              EmbedUtility.SUCCESS_COLOR(
                new MessageEmbed({
                  description: 'Please check your Direct Message!'
                })
              )
            ]
          });

          const answerList = [];

          for (const [index, value] of Object.entries(config.questions)) {
            const currentIndex = parseInt(index);
            await dmChannel
              .send({
                embeds: [
                  EmbedUtility.SUCCESS_COLOR(
                    new MessageEmbed({
                      title: `Question ${currentIndex + 1}`,
                      description: value,
                      footer: {
                        text: `Please respond within 5 minutes! | ${currentIndex + 1}/${config.questions.length}`
                      }
                    })
                  )
                ]
              })
              .catch(() => {
                verificationCollection.delete(buttonInteraction.user);
                return dmChannel.send({ embeds: [EmbedUtility.DIDNT_RESPOND_IN_TIME()] }).catch(() => {});
              });

            const answer = await handleQuestion(dmChannel);
            if (!answer) {
              verificationCollection.delete(buttonInteraction.user);
              return;
            } else {
              answerList.push(answer);
            }
          }

          verificationCollection.delete(buttonInteraction.user);

          const randomTicketId = await VerificationUtility.getUniqueTicketId();

          const transformedAnswer = answerList.map((message) => transformMessage(message));

          const verificationData = {
            id: randomTicketId,
            senderId: buttonInteraction.user.id,
            messageId: 'undefined',
            answers: {
              firstQuestion: transformedAnswer[0],
              secondAnswer: transformedAnswer[1],
              thirdAnswer: transformedAnswer[2],
              fourthAnswer: transformedAnswer[3],
              fifthAnswer: transformedAnswer[4]
            }
          };

          if (GuildUtility.verificationLogChannel) {
            const verifyMessage = await VerificationUtility.sendTicketInformation(
              GuildUtility.verificationLogChannel,
              verificationData
            );
            verificationData.messageId = (verifyMessage && verifyMessage.id) || 'undefined';
          }

          await VerificationTicket.create(verificationData);

          await dmChannel.send({
            embeds: [EmbedUtility.SUCCESS_COLOR(EmbedUtility.VERIFICATION_SUCCESS(randomTicketId))]
          });

          break;
        }
      }
    } else if (interaction.isCommand()) {
      const commandInteraction = interaction as CommandInteraction;
      const command = CommandManager.commands.get(commandInteraction.commandName);
      if (!command) return;

      if (command.peferEphemeral) await interaction.deferReply({ ephemeral: true });
      else await interaction.deferReply();

      if (command.guildId && (!interaction.guild || !command.guildId.includes(interaction.guild.id)))
        return interaction.editReply({
          embeds: [EmbedUtility.USER_TITLE(EmbedUtility.CANT_USE_HERE(), interaction.user)]
        });

      if (
        command.permission &&
        ((command.permission === 'BOT_OWNER' && !GuildUtility.isBotOwner(interaction.member)) ||
          (command.permission === 'ADMINISTRATOR' && !GuildUtility.isAdministrator(interaction.member)) ||
          (command.permission === 'MODERATOR' && !GuildUtility.isModerator(interaction.member)))
      )
        return interaction.editReply({
          embeds: [EmbedUtility.USER_TITLE(EmbedUtility.NO_PERMISSION(), interaction.user)]
        });

      command.execute(commandInteraction);
    }
  }
});
