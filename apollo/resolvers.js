import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { AuthenticationError } from 'apollo-server-core';
import { calcDistance } from 'utils/functions';
let cloudinary = require('cloudinary').v2;

const { BCRYPT_SALT_ROUNDS, JWT_SECRET_KEY } = process.env;

const resolvers = {
  Query: {
    user: async (_parent, { token }, { db }, _info) => {
      const user = jwt.verify(token, JWT_SECRET_KEY, (error, decoded) => {
        return error ? null : decoded.username;
      });

      if (!user) throw new Error('Error verifying user');

      return await db.collection('users').findOne({ username: user });
    },
    posts: async (_parent, { cursor }, { db, loggedUser }, _info) => {
      if (!loggedUser) throw new AuthenticationError('you must be logged in');

      const { location } = await db.collection('users').findOne({ username: loggedUser.username });

      let posts;

      if (cursor) {
        const postCursor = await db
          .collection('posts')
          .find({ _id: { $lt: new ObjectId(cursor) } })
          .sort({ _id: -1 })
          .limit(5);

        const hasNext = await postCursor.hasNext();

        posts = hasNext ? await postCursor.toArray() : [];
      } else {
        posts = await db
          .collection('posts')
          .find()
          .sort({ _id: -1 })
          .limit(5)
          .toArray();
      }

      if (posts.length) {
        const nextCursor = posts[posts.length - 1]._id;

        const pageInfo = {
          nextCursor,
        };

        if (location) {
          const compareDistance = (postLat, postLng) => calcDistance(postLat, postLng, location.lat, location.lng);
          // sort by distance (closest -> farthest)
          return {
            pageInfo,
            data: posts.sort(
              (a, b) =>
                compareDistance(a.location.lat, a.location.lng) - compareDistance(b.location.lat, b.location.lng)
            ),
          };
        } else {
          return { pageInfo, data: posts };
        }
      } else {
        return { pageInfo: { nextCursor: null }, data: posts };
      }
    },
    userPost: async (_parent, _args, { db, loggedUser }, _info) => {
      if (!loggedUser) throw new AuthenticationError('you must be logged in');

      const allPosts = await db
        .collection('posts')
        .find()
        .sort({ _id: -1 })
        .toArray();

      return allPosts.filter(({ content }) => content.user.username === loggedUser.username);
    },
    comments: async (_parent, { id }, { db, loggedUser }, _info) => {
      if (!loggedUser) throw new AuthenticationError('you must be logged in');

      const objId = new ObjectId(id);

      const post = await db.collection('posts').findOne({ _id: objId });

      return post.comments;
    },
    chats: async (_parent, _args, { db, loggedUser }, _info) => {
      if (!loggedUser) throw new AuthenticationError('you must be logged in');

      const allChats = await db
        .collection('chats')
        .find()
        .toArray();

      const username = loggedUser.username;

      const mappedChats = allChats.map(obj => {
        let rObj = {};
        rObj['username'] = username;
        return { ...obj, ...rObj };
      });

      const filteredChats = mappedChats
        .filter(({ participants }) => participants.filter(({ username }) => username.includes(loggedUser.username)))
        .sort((a, b) => new Date(b.lastUpdatedAt) - new Date(a.lastUpdatedAt));

      return filteredChats;
    },
    storedMessages: async (_parent, { _id }, { db, loggedUser }, _info) => {
      if (!loggedUser) throw new AuthenticationError('you must be logged in');

      const objId = new ObjectId(_id);

      const chat = await db.collection('chats').findOne({ _id: objId });
      chat.messages = chat.messages.reverse();

      return chat;
    },
    chatUser: async (_parent, { username }, { db, loggedUser }, _info) => {
      if (!loggedUser) throw new AuthenticationError('you must be logged in');

      const user = await db.collection('users').findOne({ username });

      return {
        username: user.username,
        displayName: user.displayName,
        userImage: user.userImage,
      };
    },
  },
  Mutation: {
    // <---- AUTHENTICATION ---->
    register: async (_parent, args, { db }, _info) => {
      const { username, password } = args;

      if (!username || !password) return { status: { ok: false, message: 'All fields are required.' } };

      const Users = db.collection('users');
      try {
        const user = await Users.findOne({ username });

        if (user)
          return { status: { ok: false, message: 'This username already exists. Please pick another username.' } };

        const hash = await bcrypt.hash(password, Number(BCRYPT_SALT_ROUNDS));
        const newUser = {
          username,
          password: hash,
        };
        await Users.insertOne(newUser);

        return { status: { ok: true } };
      } catch (error) {
        return { status: { ok: false, message: error } };
      }
    },
    login: async (_parent, args, { db }, _info) => {
      const { username, password } = args;

      if (!username || !password) return { status: { ok: false, message: 'All fields are required.' } };
      const Users = db.collection('users');
      try {
        const user = await Users.findOne({ username });
        if (!user) return { status: { ok: false, message: "This username doesn't exist." } };

        const match = await bcrypt.compare(password, user.password);

        if (match) {
          const token = jwt.sign(JSON.stringify(user), JWT_SECRET_KEY);

          return jwt.verify(token, JWT_SECRET_KEY, (error, decoded) => {
            return error
              ? { status: { ok: false, message: 'Something went wrong. Please try again' } }
              : {
                  status: { ok: true },
                  token,
                  user: {
                    username: decoded.username,
                    displayName: user.displayName,
                    userImage: user.userImage,
                    location: user.location,
                  },
                };
          });
        } else {
          return { status: { ok: false, message: 'Invalid password.' } };
        }
      } catch (error) {
        return { status: { ok: false, message: error } };
      }
    },

    // <---- USER ---->
    updateUser: async (_parent, { fieldsToUpdate }, { db, loggedUser }, _info) => {
      if (!loggedUser) throw new AuthenticationError('you must be logged in');

      const user = await db.collection('users').findOne({ username: loggedUser.username });

      let image = null;
      if (fieldsToUpdate.userImage) {
        await cloudinary.uploader.upload(fieldsToUpdate.userImage, function(error, result) {
          image = result.url;
        });
      }

      try {
        const payload = await db
          .collection('users')
          .findOneAndUpdate({ _id: user._id }, { $set: { ...user, ...fieldsToUpdate, userImage: image } });

        return payload.ok === 1 && { ok: true, message: 'Update successful' };
      } catch (error) {
        return { ok: false, message: 'Something went wrong' };
      }
    },
    // <---- POSTS ---->
    createPost: async (_parent, args, { db, loggedUser }, _info) => {
      if (!loggedUser) throw new AuthenticationError('you must be logged in');

      const { text, createdAt, image } = args;

      const Posts = db.collection('posts');

      const { username, displayName, userImage, location } = await db
        .collection('users')
        .findOne({ username: loggedUser.username });

      let postImage = null;

      if (image) {
        await cloudinary.uploader.upload(image, function(error, result) {
          postImage = result.url;
        });
      }

      const newPost = {
        content: {
          text,
          user: { username, displayName, userImage },
          image: postImage,
          createdAt,
        },
        location,
        status: 'TO_BORROW',
        comments: [],
      };

      await Posts.insertOne(newPost);

      return newPost;
    },
    postComment: async (_parent, args, { db, loggedUser }, _info) => {
      if (!loggedUser) throw new AuthenticationError('you must be logged in');

      const { text, createdAt, id } = args;

      const Posts = db.collection('posts');
      const objId = new ObjectId(id);

      const postCurrentComments = await Posts.findOne({ _id: objId });

      const { username, displayName, userImage } = await db
        .collection('users')
        .findOne({ username: loggedUser.username });

      const newComment = {
        text,
        createdAt,
        user: { username, displayName, userImage },
      };

      await Posts.findOneAndUpdate(
        { _id: objId },
        { $set: { comments: [...postCurrentComments.comments, newComment] } }
      );

      return newComment;
    },
    updatePostStatus: async (_parent, { id }, { db, loggedUser }, _info) => {
      if (!loggedUser) throw new AuthenticationError('you must be logged in');

      const objId = new ObjectId(id);

      try {
        const payload = await db.collection('posts').findOneAndUpdate({ _id: objId }, { $set: { status: 'BORROWED' } });
        return payload.ok === 1 && { ok: true, message: 'Update successful' };
      } catch (error) {
        return { ok: false, message: 'Something went wrong' };
      }
    },
    removePost: async (_parent, { id }, { db, loggedUser }, _info) => {
      if (!loggedUser) throw new AuthenticationError('you must be logged in');

      const objId = new ObjectId(id);

      try {
        const payload = await db.collection('posts').deleteOne({ _id: objId });

        return payload.result.ok === 1 && { ok: true, message: 'Update successful' };
      } catch (error) {
        return { ok: false, message: 'Something went wrong' };
      }
    },

    // <---- CHATS ---->
    postMessage: async (_parent, args, { db, loggedUser }, _info) => {
      const { to, message, createdAt } = args;

      // find chats participants where it includes both from and to
      const Chats = db.collection('chats');

      const allChats = await Chats.find().toArray();
      // participants.includes(loggedUser.username) && participants.includes(to.username)
      const matchedMessages = allChats.find(({ participants }) =>
        participants.map(({ username }) => username === loggedUser.username && username === to.username)
      );

      const newMessage = {
        from: loggedUser.username,
        to: to.username,
        message,
        createdAt,
      };

      const chatUserInfo = {
        username: loggedUser.username,
        displayName: loggedUser.displayName,
        userImage: loggedUser.userImage,
      };
      // if chats already exist, update Chat object to the Chats
      if (matchedMessages) {
        await Chats.findOneAndUpdate(
          { _id: matchedMessages._id },
          { $set: { messages: [...matchedMessages.messages, newMessage], lastUpdatedAt: `${new Date()}` } }
        );
      } else {
        // else, insert new Chat object with the participants
        await Chats.insertOne({
          participants: [chatUserInfo, to],
          messages: [newMessage],
          lastUpdatedAt: `${new Date()}`,
        });
      }
    },
  },
};

export default resolvers;
