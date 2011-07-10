var mailru_session_manager = {
	// DB vars
	dbConnection: null,
	dbTables: {
		stat:     "id INTEGER PRIMARY KEY, name TEXT, value TEXT",
		accounts: "id INTEGER PRIMARY KEY, name TEXT, active INTEGER, UNIQUE(name)",
		cookies:  "id INTEGER PRIMARY KEY, account_id INTEGER, name TEXT, value TEXT, host TEXT, path TEXT, expires INTEGER, isSecure INTEGER, CONSTRAINT moz_uniqueid UNIQUE (account_id, name, host, path)"
	},

	// Timers
	faviconTimer: null,

	// New mail checker
	checkNewMailInterval: 1,
	newMail: {},

	// Initialize addon
	onLoad: function() {
		this.initialized = true;
		// active account
		this.activeAccount = 0;
		// init strings
		this.strings = document.getElementById("mailru-session-manager-strings");
		// init XUL
		this.XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
		// init cookies managers
		this.cookieManager  = Components.classes["@mozilla.org/cookiemanager;1"].getService(Components.interfaces.nsICookieManager);
		this.cookieManager2 = Components.classes["@mozilla.org/cookiemanager;1"].getService(Components.interfaces.nsICookieManager2);
		// init cookie service
		this.cookieService = Components.classes["@mozilla.org/cookieService;1"].getService(Components.interfaces.nsICookieService);
		// init IO service
		this.IOService = Components.classes["@mozilla.org/network/io-service;1"].getService(Components.interfaces.nsIIOService);
		// init prompt service
		this.promptService = Components.classes["@mozilla.org/embedcomp/prompt-service;1"].getService(Components.interfaces.nsIPromptService);
		// init observer service
		this.observerService = Components.classes["@mozilla.org/observer-service;1"].getService(Components.interfaces.nsIObserverService);
		// init DB
		this.dbInit();

		this.StreamListener = function(aChannel, aCookies, aAccount, aContext, aCallbackFunc) {
			this.channel = aChannel;
			this.cookies = aCookies;
			this.account = aAccount;
			this.context = aContext;
			this.callbackFunc = aCallbackFunc;
		};
		this.StreamListener.prototype = {
			mData: '',
			observe: function(aSubject, aTopic, aData) {
				// Make sure it is our connection first.
				if (aSubject == this.channel) {
					var httpChannel = aSubject.QueryInterface(Components.interfaces.nsIHttpChannel);
					if (aTopic == "http-on-modify-request") {
						httpChannel.setRequestHeader("Cookie", this.cookies, false);
					} else if (aTopic == "http-on-examine-response") {
						httpChannel.setResponseHeader("Set-Cookie", '', false);
					}
				}
			},
			onStartRequest: function(aRequest, aContext) {
				this.mData = '';
			},
			onDataAvailable: function(aRequest, aContext, aStream, aSourceOffset, aLength) {
				var scriptableInputStream = Components.classes["@mozilla.org/scriptableinputstream;1"].createInstance(Components.interfaces.nsIScriptableInputStream);
				scriptableInputStream.init(aStream);
				this.mData += scriptableInputStream.read(aLength);
			},
			onStopRequest: function(aRequest, aContext, aStatus) {
				if (Components.isSuccessCode(aStatus)) {
					// request was successfull
					this.callbackFunc(this.mData, this.account, this.context);
				} else {
					// request failed
					this.callbackFunc(null, null, null);
				}
				this.channel = null;
			},
			onChannelRedirect: function(aOldChannel, aNewChannel, aFlags) {
				// if redirecting, store the new channel
				this.channel = aNewChannel;
			},
			getInterface: function(aIID) {
				try {
					return this.QueryInterface(aIID);
				} catch (e) {
					throw Components.results.NS_NOINTERFACE;
				}
			},
			onProgress: function(aRequest, aContext, aProgress, aProgressMax) {},
			onStatus: function(aRequest, aContext, aStatus, aStatusArg) {},
			onRedirect: function(aOldChannel, aNewChannel) {},
			QueryInterface: function(aIID) {
				if (aIID.equals(Components.interfaces.nsISupports) ||
					aIID.equals(Components.interfaces.nsIInterfaceRequestor) ||
					aIID.equals(Components.interfaces.nsIChannelEventSink) ||
					aIID.equals(Components.interfaces.nsIProgressEventSink) ||
					aIID.equals(Components.interfaces.nsIHttpEventSink) ||
					aIID.equals(Components.interfaces.nsIStreamListener) ||
					aIID.equals(Components.interfaces.nsIObserver))
				{
					return this;
				}
				throw Components.results.NS_NOINTERFACE;
			}
		};

		// run check new mail
		this.checkNewMail();
	},

	// Create table (internal)
	_dbCreateTables: function(aDBConnection) {
		for (var name in this.dbTables) {
			aDBConnection.createTable(name, this.dbTables[name]);
		}
	},

	// Create database (internal)
	_dbCreate: function(aDBService, aDBFile) {
		var dbConnection = aDBService.openDatabase(aDBFile);
		this._dbCreateTables(dbConnection);
		return dbConnection;
	},

	// Initialize database
	dbInit: function() {
		// prepare for work with DB
		var dirService = Components.classes["@mozilla.org/file/directory_service;1"].getService(Components.interfaces.nsIProperties);
		var dbFile = dirService.get("ProfD", Components.interfaces.nsIFile);
		dbFile.append("mailru-sessions.sqlite");
		var dbService = Components.classes["@mozilla.org/storage/service;1"].getService(Components.interfaces.mozIStorageService);

		// create DB connection
		var dbConnection;
		if (!dbFile.exists()) {
			// create DB if it is not exists
			dbConnection = this._dbCreate(dbService, dbFile);
			// save DB version into stats
			var statement = dbConnection.createStatement("INSERT INTO stat (name, value) VALUES ('version', '0.4.2')");
			statement.execute();
			statement.finalize();
		} else {
			// DB exists - open it
			dbConnection = dbService.openDatabase(dbFile);
		}
		this.dbConnection = dbConnection;
	},

	// Load accounts from database
	getAccounts: function() {
		var accounts = [];

		this.activeAccount = 0;
		var statement = this.dbConnection.createStatement("SELECT id, name, active FROM accounts ORDER BY name");
		try {
			while (statement.step()) {
				accounts.push({
					'id':     statement.row.id,
					'name':   statement.row.name,
					'active': statement.row.active
				});
				if (statement.row.active) {
					this.activeAccount = statement.row.id;
				}
			}
		} finally {
			statement.reset();
		}

		return accounts;
	},

	// Fill menu with accounts
	menuFillAccounts: function(e) {
		var menu = document.getElementById('mailru-session-manager-toolbar-menu');
		if (menu.hasChildNodes()) {
			while (menu.firstChild.nodeName != 'menuseparator') {
				menu.removeChild(menu.firstChild);
			}
		}
		var separator = menu.firstChild;

		var accounts = this.getAccounts();
		if (accounts.length > 0) {
			var active_account = false;
			for (var i = 0, l = accounts.length; i < l; i++) {
				if (!active_account && accounts[i].active) {
					active_account = true;
				}
				var item = document.createElementNS(this.XUL_NS, 'menuitem');
				item.setAttribute('id',      'mailru-session-manager-toolbar-menu-item-' + accounts[i].id);
				item.setAttribute('name',    'mailru-session-manager-account');
				item.setAttribute('type',    'radio');
				item.setAttribute('value',   accounts[i].id);
				if (this.newMail[accounts[i].name] == undefined) {
					item.setAttribute('label',   accounts[i].name);
				} else {
					item.setAttribute('label',   accounts[i].name + ' (' + this.newMail[accounts[i].name] + ')');
				}
				item.setAttribute('checked', accounts[i].active ? true : false);
				item.addEventListener('command', this.onSelectAccount.bind(this), true);
				menu.insertBefore(item, separator);
			}
			document.getElementById('mailru-session-manager-toolbar-menu-add-clean').disabled = !active_account;
			document.getElementById('mailru-session-manager-toolbar-menu-remove').disabled = !active_account;
		} else {
			var item = document.createElementNS(this.XUL_NS, 'menuitem');
			item.setAttribute('id',       'mailru-session-manager-toolbar-menu-empty');
			item.setAttribute('value',    '0');
			item.setAttribute('label',    this.strings.getString('noSessions'));
			item.setAttribute('disabled', true);
			menu.insertBefore(item, separator);
			document.getElementById('mailru-session-manager-toolbar-menu-add-clean').disabled = true;
			document.getElementById('mailru-session-manager-toolbar-menu-remove').disabled = true;
		}
		return true;
	},

	// Build cookie string
	buildCookie: function(cookie) {
		// name - value
		var cookieString = cookie.name + '=' + cookie.value;
		// expires
		if (cookie.expires > 0) {
			cookieString = cookieString + ";expires=" + (new Date(cookie.expires * 1000)).toGMTString();
		}
		// path
		cookieString = cookieString + ";path=" + cookie.path;
		// host
		cookieString = cookieString + ";domain=" + cookie.host;
		// secure
		if (cookie.isSecure == true) {
			cookieString = cookieString + ";secure";
		}
		return cookieString;
	},

	// Store firefox cookies into account DB
	storeCookies: function(account_id) {
		// get cookies from firefox
		var cookies = [];
		for (var e = this.cookieManager.enumerator; e.hasMoreElements();) {
			var cookie = e.getNext().QueryInterface(Components.interfaces.nsICookie);
			if (cookie.host == '.mail.ru') {
				cookies.push({
					'name':         cookie.name,
					'value':        cookie.value,
					'host':         cookie.host,
					'path':         cookie.path,
					'expires':      cookie.expires,
					'isSecure':     cookie.isSecure
				});
			}
		}

		// clear cookies in DB for account
		var statement = this.dbConnection.createStatement("DELETE FROM cookies WHERE account_id = ?1");
		statement.bindInt32Parameter(0, account_id);
		statement.execute();

		// insert cookies into DB for account
		for (var i = 0, l = cookies.length; i < l; i++) {
			var cookie = cookies[i];
			statement = this.dbConnection.createStatement("INSERT INTO cookies (account_id, name, value, host, path, expires, isSecure) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)");
			statement.bindInt32Parameter( 0, account_id);
			statement.bindStringParameter(1, cookie.name);
			statement.bindStringParameter(2, cookie.value);
			statement.bindStringParameter(3, cookie.host);
			statement.bindStringParameter(4, cookie.path);
			statement.bindInt64Parameter( 5, cookie.expires);
			statement.bindInt32Parameter( 6, cookie.isSecure);
			statement.execute();
		}
		statement.finalize();
	},

	// Restore cookies from DB into firefox
	restoreCookies: function(account_id) {
		// get cookies from DB for account
		cookies = [];
		var statement = this.dbConnection.createStatement("SELECT name, value, host, path, expires, isSecure FROM cookies WHERE account_id = ?1");
		statement.bindInt32Parameter(0, account_id);
		try {
			while (statement.step()) {
				cookies.push({
					'name':         statement.row.name,
					'value':        statement.row.value,
					'host':         statement.row.host,
					'path':         statement.row.path,
					'expires':       statement.row.expires,
					'isSecure':     statement.row.isSecure
				});
			}
		} finally {
			statement.reset();
		}

		// clear cookies in firefox
		var cnt = 0;
		for (var e = this.cookieManager.enumerator; e.hasMoreElements();) {
			var cookie = e.getNext().QueryInterface(Components.interfaces.nsICookie);
			if (cookie.host == '.mail.ru') {
				this.cookieManager.remove(cookie.host, cookie.name, cookie.path, false);
				cnt++;
			}
		}

		// set cookies from DB into forefox
		for (var i = 0, l = cookies.length; i < l; i++) {
			this.cookieService.setCookieString(
				this.IOService.newURI(cookies[i].isSecure ? "https://mail.ru" : "http://mail.ru", null, null),
				null,
				this.buildCookie(cookies[i]),
				null
			);
		}
	},

	// Clear cookies in firefox
	clearCookies: function() {
		var cnt = 0;
		for (var e = this.cookieManager.enumerator; e.hasMoreElements();) {
			var cookie = e.getNext().QueryInterface(Components.interfaces.nsICookie);
			if (cookie.host == '.mail.ru') {
				this.cookieManager.remove(cookie.host, cookie.name, cookie.path, false);
				cnt++;
			}
		}
	},

	// Set account as active
	setAccountActive: function(account_id) {
		var statement = this.dbConnection.createStatement("UPDATE accounts SET active = CASE id WHEN ?1 THEN 1 ELSE 0 END");
		statement.bindInt32Parameter(0, account_id);
		statement.execute();
		statement.finalize();

		this.activeAccount = account_id;

		this.checkNewMail();
	},

	// Create new account
	addAccount: function(account_name) {
		// insert new record
		var statement = this.dbConnection.createStatement("INSERT INTO accounts (name, active) VALUES (?1, 0)");
		statement.bindStringParameter(0, account_name);
		statement.execute();
		statement.finalize();

		// select new account id
		var account_id = 0;
		statement = this.dbConnection.createStatement("SELECT last_insert_rowid() AS account_id;");
		try {
			while (statement.step()) {
				account_id = statement.row.account_id;
			}
		} finally {
			statement.reset();
		}

		this.checkNewMail();

		return account_id;
	},

	// Remove account
	removeAccount: function(account_id) {
		var statement = this.dbConnection.createStatement("DELETE FROM accounts WHERE id = ?1");
		statement.bindInt32Parameter(0, account_id);
		statement.execute();

		statement = this.dbConnection.createStatement("DELETE FROM cookies WHERE account_id = ?1");
		statement.bindInt32Parameter(0, account_id);
		statement.execute();

		statement.finalize();

		this.checkNewMail();
	},

	// Select an account
	onSelectAccount: function(e) {
		var account_id = Number(e.currentTarget.value);
		if (account_id > 0) {
			if (this.activeAccount > 0) {
				this.storeCookies(this.activeAccount);
			}
			this.restoreCookies(account_id);
			this.setAccountActive(account_id);

			// check each tab of this browser instance
			var numTabs = gBrowser.browsers.length;
			for (var index = 0; index < numTabs; index++) {
				var currentBrowser = gBrowser.getBrowserAtIndex(index);
				// reload tab if it is mail.ru page
				if (currentBrowser.currentURI.host == 'mail.ru' || currentBrowser.currentURI.host.match('.mail.ru$')) {
					gBrowser.reloadTab(gBrowser.tabContainer.childNodes[index]);
				}
			}
		}

		this.checkNewMail();
	},

	// Save current session with new name
	onSaveCurrentSession: function(e) {
		// check if we have cookies
		var cookie_is_exists = false;
		var cookie_is_session_only = false;
		for (var e = this.cookieManager.enumerator; e.hasMoreElements();) {
			var cookie = e.getNext().QueryInterface(Components.interfaces.nsICookie);
			if (cookie.host == '.mail.ru' && cookie.name == 'Mpop') {
				cookie_is_exists = true;
				if (cookie.expires == 0) {
					cookie_is_session_only = true;
				}
				break;
			}
		}

		if (!cookie_is_exists) {
			// cookie is not exists - warn user
			if (!this.promptService.confirm(window, this.strings.getString('saveSession.not_exists_title'), this.strings.getString('saveSession.not_exists_text'))) {
				return false;
			}
		} else if (cookie_is_session_only) {
			// cookie is session-only - warn user
			if (!this.promptService.confirm(window, this.strings.getString('saveSession.session_only_title'), this.strings.getString('saveSession.session_only_text'))) {
				return false;
			}
		}

		var saved = false;
		var state = false;
		var result = {
			input: {value: ''},
			check: {value: false}
		};
		var prompt_text = this.strings.getString('saveSession.text');
		while (!saved) {
			if (!this.promptService.prompt(null, this.strings.getString('saveSession.title'), prompt_text, result.input, null, result.check)) {
				return false;
			}
			// trim input
			result.input.value = result.input.value.replace(/^\s\s*/, '').replace(/\s\s*$/, '');

			if (result.input.value == '') {
				// account is empty
				prompt_text = this.strings.getString('saveSession.empty');
			} else {
				// check account name
				var is_exists = false;
				var statement = this.dbConnection.createStatement("SELECT id FROM accounts WHERE name = ?1");
				statement.bindStringParameter(0, result.input.value);
				try {
					while (statement.step()) {
						is_exists = true;
					}
				} finally {
					statement.reset();
				}

				if (is_exists) {
					// account is exists
					prompt_text = this.strings.getString('saveSession.exists');
					prompt_text = prompt_text.replace('##name##', result.input.value);
				} else {
					// account is new - save it
					var account_id = this.addAccount(result.input.value);

					if (account_id > 0) {
						this.storeCookies(account_id);
						this.setAccountActive(account_id);
					} else {
						this.promptService.alert(window, this.strings.getString('saveSession.error_title'), this.strings.getString('saveSession.error_text'));
					}
					saved = true;
				}
			}
		}

		this.checkNewMail();
	},

	// Open new session
	onOpenNewEmptySession: function(e) {
		var account_id = 0;
		if (this.activeAccount > 0) {
			this.storeCookies(this.activeAccount);
			this.clearCookies();
			this.setAccountActive(account_id);
		}

		this.checkNewMail();
	},

	// Remove current session from list
	onRemoveCurrentSession: function(e) {
		if (this.activeAccount > 0 && this.promptService.confirm(window, this.strings.getString('removeSession.title'), this.strings.getString('removeSession.text'))) {
			this.removeAccount(this.activeAccount);
			this.clearCookies();
			this.setAccountActive(0);
		}

		this.checkNewMail();
	},

	// Check new mail
	checkNewMail: function() {
		var accounts = this.getAccounts();
		if (accounts.length > 0) {
			var statement;
			var uri = this.IOService.newURI('http://e.mail.ru/cgi-bin/mailcnt?json=1', null, null);
			for (var i = 0, l = accounts.length; i < l; i++) {
				// get cookies from DB for account
				cookies = [];
				statement = this.dbConnection.createStatement("SELECT name, value FROM cookies WHERE account_id = ?1");
				statement.bindInt32Parameter(0, accounts[i].id);
				try {
					while (statement.step()) {
						cookies.push(statement.row.name + '=' + statement.row.value);
					}
				} finally {
					statement.reset();
				}

				// create request
				var channel = this.IOService.newChannelFromURI(uri);
				var listener = new this.StreamListener(channel, cookies.join(' '), accounts[i], this, function(data, account, context) {
					if (data != null) {
						var mail_count = /NewMailCNT:"(\d+)"/.exec(data);
						if (mail_count) {
							context.newMail[account.name] = mail_count[1];
						} else {
							context.newMail[account.name] = context.strings.getString('checkNewMail.not_logged_in');
						}
					} else {
						context.newMail[account.name] = context.strings.getString('checkNewMail.error');
					}
				});
				this.observerService.addObserver(listener, "http-on-modify-request", false);
				this.observerService.addObserver(listener, "http-on-examine-response", false);
				channel.notificationCallbacks = listener;
				channel.asyncOpen(listener, null);
			}
		}

		this.faviconTimer = setTimeout(function() { mailru_session_manager.checkNewMail() }, this.checkNewMailInterval * 60000);
	}
};

window.addEventListener("load", function () { mailru_session_manager.onLoad(); }, false);

