var	RDB = require('./redis.js'),
	topics = require('./topics.js'),
	categories = require('./categories.js'),
	user = require('./user.js'),
	async = require('async'),
	notifications = require('./notifications.js');

(function(ThreadTools) {
	
	ThreadTools.privileges = function(tid, uid, callback) {
		//todo: break early if one condition is true 
		
		function getCategoryPrivileges(next) {
			topics.getTopicField(tid, 'cid', function(cid) {
				categories.privileges(cid, uid, function(privileges) {
					next(null, privileges);
				});
			});
		}

		function hasEnoughRep(next) {
			user.getUserField(uid, 'reputation', function(reputation) {
				next(null, reputation >= global.config['privileges:manage_topic']);
			});
		}
		

		async.parallel([getCategoryPrivileges, hasEnoughRep], function(err, results) {
			callback({
				editable: results[0].editable || (results.slice(1).indexOf(true) !== -1 ? true : false),
				view_deleted: results[0].view_deleted || (results.slice(1).indexOf(true) !== -1 ? true : false)
			});
		});
	}

	ThreadTools.lock = function(tid, uid, socket) {
		ThreadTools.privileges(tid, uid, function(privileges) {
			if (privileges.editable) {
				topics.setTopicField(tid, 'locked', 1);

				if (socket) {
					io.sockets.in('topic_' + tid).emit('event:topic_locked', {
						tid: tid,
						status: 'ok'
					});

					socket.emit('api:topic.lock', {
						status: 'ok',
						tid: tid
					});
				}
			}
		});
	}

	ThreadTools.unlock = function(tid, uid, socket) {
		ThreadTools.privileges(tid, uid, function(privileges) {
			if (privileges.editable) {
				topics.setTopicField(tid, 'locked', 0);

				if (socket) {
					io.sockets.in('topic_' + tid).emit('event:topic_unlocked', {
						tid: tid,
						status: 'ok'
					});

					socket.emit('api:topic.unlock', {
						status: 'ok',
						tid: tid
					});
				}
			}
		});
	}

	ThreadTools.delete = function(tid, uid, socket) {
		ThreadTools.privileges(tid, uid, function(privileges) {
			if (privileges.editable) {
				
				topics.setTopicField(tid, 'deleted', 1);
				ThreadTools.lock(tid, uid);

				if (socket) {
					io.sockets.in('topic_' + tid).emit('event:topic_deleted', {
						tid: tid,
						status: 'ok'
					});

					socket.emit('api:topic.delete', {
						status: 'ok',
						tid: tid
					});
				}
			}
		});
	}

	ThreadTools.restore = function(tid, uid, socket) {
		ThreadTools.privileges(tid, uid, function(privileges) {
			if (privileges.editable) {

				topics.setTopicField(tid, 'deleted', 0);
				ThreadTools.unlock(tid, uid);

				if (socket) {
					io.sockets.in('topic_' + tid).emit('event:topic_restored', {
						tid: tid,
						status: 'ok'
					});

					socket.emit('api:topic.restore', {
						status: 'ok',
						tid: tid
					});
				}
			}
		});
	}

	ThreadTools.pin = function(tid, uid, socket) {
		ThreadTools.privileges(tid, uid, function(privileges) {
			if (privileges.editable) {
				
				topics.setTopicField(tid, 'pinned', 1);

				if (socket) {
					io.sockets.in('topic_' + tid).emit('event:topic_pinned', {
						tid: tid,
						status: 'ok'
					});

					socket.emit('api:topic.pin', {
						status: 'ok',
						tid: tid
					});
				}
			}
		});
	}

	ThreadTools.unpin = function(tid, uid, socket) {
		ThreadTools.privileges(tid, uid, function(privileges) {
			if (privileges.editable) {
				
				topics.setTopicField(tid, 'pinned', 0);

				if (socket) {
					io.sockets.in('topic_' + tid).emit('event:topic_unpinned', {
						tid: tid,
						status: 'ok'
					});

					socket.emit('api:topic.unpin', {
						status: 'ok',
						tid: tid
					});
				}
			}
		});
	}

	ThreadTools.move = function(tid, cid, socket) {
		
		topics.getTopicField(tid, 'cid', function(oldCid) {

			RDB.smove('categories:' + oldCid + ':tid', 'categories:' + cid + ':tid', tid, function(err, result) {
				if (!err && result === 1) {

					topics.setTopicField(tid, 'cid', cid);
					
					categories.incrementCategoryFieldBy(oldCid, 'topic_count', -1);
					categories.incrementCategoryFieldBy(cid, 'topic_count', 1);

					categories.getCategories([cid], function(data) {
						topics.setTopicField(tid, 'category_name', data.categories[0].name);
						topics.setTopicField(tid, 'category_slug', data.categories[0].slug);
					});

					socket.emit('api:topic.move', {
						status: 'ok'
					});
					io.sockets.in('topic_' + tid).emit('event:topic_moved', {
						tid: tid
					});
				} else {
					socket.emit('api:topic.move', {
						status: 'error'
					});
				}
			});
		});
	}

	ThreadTools.isFollowing = function(tid, current_user, callback) {
		RDB.sismember('tid:' + tid + ':followers', current_user, function(err, following) {
			callback(following);
		});
	}

	ThreadTools.toggleFollow = function(tid, current_user, callback) {
		ThreadTools.isFollowing(tid, current_user, function(following) {
			if (!following) {
				RDB.sadd('tid:' + tid + ':followers', current_user, function(err, success) {
					if (callback) {
						if (!err) {
							callback({
								status: 'ok',
								follow: true
							});
						} else callback({ status: 'error' });
					}
				});
			} else {
				RDB.srem('tid:' + tid + ':followers', current_user, function(err, success) {
					if (callback) {
						if (!err) {
							callback({
								status: 'ok',
								follow: false
							});
						} else callback({ status: 'error' });
					}
				});
			}
		});
	}

	ThreadTools.get_followers = function(tid, callback) {
		RDB.smembers('tid:' + tid + ':followers', function(err, followers) {
			callback(err, followers);
		});
	}

	ThreadTools.notify_followers = function(tid, exceptUid) {
		async.parallel([
			function(next) {
				
				topics.getTopicField(tid, 'title', function(title) {
					topics.getTeaser(tid, function(teaser) {
							notifications.create(teaser.username + ' has posted a reply to: "' + title + '"', null, '/topic/' + tid, 'topic:' + tid, function(nid) {
							next(null, nid);
						});
					});
				});
					
				
			},
			function(next) {
				ThreadTools.get_followers(tid, function(err, followers) {
					if (followers.indexOf(exceptUid) !== -1) followers.splice(followers.indexOf(exceptUid), 1);
					next(null, followers);
				});
			}
		], function(err, results) {
			if (!err) {
				notifications.push(results[0], results[1]);
			}
		});
	}

}(exports));