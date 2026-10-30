%% Redirect recognized ghost credentials in supported Finch, hackney and httpc calls.
%% See README.md for release boot timing, configuration and transport boundaries.
-module(vallkey_auto).

-export([start/0, undefined_function/3, patch/1, rewrite/2]).

-define(GHOST, "gk_[a-z]{2,20}_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}").
-define(HOOK_HEADER, <<"x-vallkey-host">>).
-define(WHO_HEADER, <<"x-vallkey-hook">>).
-define(VERSION, "0.1.0").

%% The platform, from variables each one sets itself. The same list, in the same order, is
%% in every Vallkey hook, so the dashboard names a place the same way in any language.
platforms() ->
    [{"VERCEL", "vercel"}, {"AWS_LAMBDA_FUNCTION_NAME", "aws-lambda"}, {"ECS_CONTAINER_METADATA_URI_V4", "aws-ecs"},
     {"ECS_CONTAINER_METADATA_URI", "aws-ecs"}, {"FUNCTION_TARGET", "cloud-functions"}, {"K_SERVICE", "cloud-run"},
     {"GAE_APPLICATION", "app-engine"}, {"FUNCTIONS_WORKER_RUNTIME", "azure-functions"}, {"CONTAINER_APP_NAME", "azure-container-apps"},
     {"WEBSITE_SITE_NAME", "azure-app-service"}, {"RAILWAY_PROJECT_ID", "railway"}, {"RENDER", "render"}, {"FLY_APP_NAME", "fly"},
     {"DYNO", "heroku"}, {"NETLIFY", "netlify"}, {"KOYEB_APP_NAME", "koyeb"}, {"GITHUB_ACTIONS", "github-actions"},
     {"GITLAB_CI", "gitlab-ci"}, {"KUBERNETES_SERVICE_HOST", "kubernetes"}].

%% What sent the request, for x-vallkey-hook.
who() ->
    case persistent_term:get(vallkey_who, undefined) of
        undefined ->
            {Lang, Runtime} = case application:get_key(elixir, vsn) of
                {ok, V} -> {"elixir", V};
                undefined -> {"erlang", erlang:system_info(otp_release)}
            end,
            Set = fun(Name) -> case os:getenv(Name) of false -> false; "" -> false; _ -> true end end,
            Platform = case [P || {Var, P} <- platforms(), Set(Var)] of
                [P | _] -> P;
                [] -> case filelib:is_regular("/.dockerenv") of true -> "docker"; false -> none end
            end,
            Env = os:getenv("VALLKEY_ENV", ""),
            Parts = [Lang ++ "/" ++ ?VERSION, "runtime=" ++ Runtime]
                ++ [ "platform=" ++ Platform || Platform =/= none ]
                ++ [ "env=" ++ Env || re:run(Env, "^[A-Za-z0-9._-]{1,40}$", [{capture, none}]) =:= match ],
            Who = unicode:characters_to_binary(lists:join("; ", Parts)),
            persistent_term:put(vallkey_who, Who),
            Who;
        Who -> Who
    end.
-define(ORIG_HANDLER, vallkey_error_handler_orig).

%% The entry points: {Module, Function, Arity, Kind}.
targets() ->
    [{'Elixir.Finch', request, 3, finch},
     {'Elixir.Finch', 'request!', 3, finch},
     {'Elixir.Finch', stream, 5, finch},
     {'Elixir.Finch', stream_while, 5, finch},
     {'Elixir.Finch', async_request, 3, finch},
     {hackney, request, 3, hackney},
     {hackney, request, 4, hackney},
     {hackney, request, 5, hackney},
     {httpc, request, 4, httpc},
     {httpc, request, 5, httpc}].

target_modules() -> lists:usort([M || {M, _, _, _} <- targets()]).

%% ---- starting ----

start() ->
    case os:getenv("VALLKEY_AUTO") of
        "0" -> ok;
        _ ->
            case persistent_term:get(vallkey_started, false) of
                true -> ok;
                false ->
                    persistent_term:put(vallkey_started, true),
                    try
                        install_error_handler(),
                        [patch(M) || M <- target_modules(), code:is_loaded(M) =/= false],
                        %% A module can also be loaded without a call (Code.ensure_loaded?):
                        %% those are caught up with here.
                        spawn(fun() -> watch(0) end),
                        ok
                    catch Class:Reason ->
                        debug("could not start: ~p:~p", [Class, Reason]),
                        ok
                    end
            end
    end.

watch(Round) ->
    timer:sleep(if Round < 600 -> 50; true -> 1000 end),
    [safe_patch(M) || M <- target_modules(), code:is_loaded(M) =/= false, not patched(M)],
    watch(Round + 1).

safe_patch(M) ->
    try patch(M) catch _:_ -> ok end.

%% ---- Erlang's handler for undefined functions, wrapped ----

install_error_handler() ->
    case code:is_loaded(?ORIG_HANDLER) of
        {file, _} -> ok;
        false ->
            {error_handler, Bin, File} = code:get_object_code(error_handler),
            {ok, Renamed} = rename_module(Bin, ?ORIG_HANDLER),
            {module, ?ORIG_HANDLER} = code:load_binary(?ORIG_HANDLER, File, Renamed),
            Exports = [FA || {F, _} = FA <- ?ORIG_HANDLER:module_info(exports), F =/= module_info],
            Forms = [{attribute, 1, module, error_handler}, {attribute, 1, export, Exports}]
                ++ [handler_function(F, A) || {F, A} <- Exports],
            {ok, error_handler, WBin} = compile:forms(Forms, [binary, return_errors]),
            code:unstick_mod(error_handler),
            {module, error_handler} = code:load_binary(error_handler, File, WBin),
            code:stick_mod(error_handler),
            ok
    end.

handler_function(F, A) ->
    Vars = [{var, 1, list_to_atom("A" ++ integer_to_list(N))} || N <- lists:seq(1, A)],
    Mod = case {F, A} of {undefined_function, 3} -> ?MODULE; _ -> ?ORIG_HANDLER end,
    {function, 1, F, A, [{clause, 1, Vars, [], [{call, 1, {remote, 1, {atom, 1, Mod}, {atom, 1, F}}, Vars}]}]}.

undefined_function(M, F, Args) ->
    case persistent_term:get({vallkey_hook, M, F, length(Args)}, undefined) of
        {Kind, Orig} -> apply(M, Orig, rewrite(Kind, Args));
        undefined ->
            case is_target(M) andalso code:is_loaded(M) =:= false of
                true ->
                    %% The first call loads the module: it is changed before the call goes on.
                    case code:ensure_loaded(M) of
                        {module, M} ->
                            safe_patch(M),
                            case persistent_term:get({vallkey_hook, M, F, length(Args)}, undefined) of
                                {Kind, Orig} -> apply(M, Orig, rewrite(Kind, Args));
                                undefined -> ?ORIG_HANDLER:undefined_function(M, F, Args)
                            end;
                        _ -> ?ORIG_HANDLER:undefined_function(M, F, Args)
                    end;
                false -> ?ORIG_HANDLER:undefined_function(M, F, Args)
            end
    end.

is_target(M) -> lists:keymember(M, 1, targets()).

%% ---- changing a module as it is loaded ----

orig_name(F) -> list_to_atom("vallkey_orig_" ++ atom_to_list(F)).

patched(M) -> persistent_term:get({vallkey_patched, M}, false).

patch(M) ->
    case patched(M) of
        true -> ok;
        false ->
            Hooks = [{F, A, Kind} || {TM, F, A, Kind} <- targets(), TM =:= M],
            Exported = M:module_info(exports),
            Wanted = [H || {F, A, _} = H <- Hooks, lists:member({F, A}, Exported)],
            case Wanted of
                [] -> persistent_term:put({vallkey_patched, M}, true);
                _ ->
                    {M, Bin, File} = code:get_object_code(M),
                    {ok, New} = rename_exports(Bin, [{F, A} || {F, A, _} <- Wanted]),
                    %% Only replace a module no process still runs an older copy of.
                    case code:soft_purge(M) of
                        true ->
                            {module, M} = code:load_binary(M, File, New),
                            [persistent_term:put({vallkey_hook, M, F, A}, {Kind, orig_name(F)}) || {F, A, Kind} <- Wanted],
                            persistent_term:put({vallkey_patched, M}, true),
                            debug("covering ~s", [M]);
                        false -> ok
                    end
            end
    end.

%% The module with the given functions exported as vallkey_orig_<name> instead.
rename_exports(Bin, FAs) ->
    {ok, _, Chunks} = beam_lib:all_chunks(Bin),
    {Format, Atoms} = decode_atoms(chunk(Chunks)),
    Index = fun(Name) -> index_of(Name, Atoms, 1) end,
    NewNames = [atom_to_binary(orig_name(F), utf8) || {F, _} <- FAs],
    Atoms2 = Atoms ++ [N || N <- NewNames, Index(N) =:= 0],
    Index2 = fun(Name) -> index_of(Name, Atoms2, 1) end,
    Map = maps:from_list([{{Index(atom_to_binary(F, utf8)), A}, Index2(atom_to_binary(orig_name(F), utf8))} || {F, A} <- FAs]),
    {"ExpT", <<N:32, Entries/binary>>} = lists:keyfind("ExpT", 1, Chunks),
    NewEntries = << <<(maps:get({Fun, Ar}, Map, Fun)):32, Ar:32, Label:32>> || <<Fun:32, Ar:32, Label:32>> <= Entries >>,
    Chunks2 = lists:map(fun({"ExpT", _}) -> {"ExpT", <<N:32, NewEntries/binary>>};
                           ({Id, _}) when Id =:= "AtU8"; Id =:= "Atom" -> {Id, encode_atoms(Format, Atoms2)};
                           (C) -> C
                        end, Chunks),
    beam_lib:build_module(Chunks2).

%% The module under another name (for Erlang's own handler, which never names itself).
rename_module(Bin, NewName) ->
    {ok, _, Chunks} = beam_lib:all_chunks(Bin),
    {Format, [_ | Rest]} = decode_atoms(chunk(Chunks)),
    Atoms = [atom_to_binary(NewName, utf8) | Rest],
    beam_lib:build_module([case Id of "AtU8" -> {Id, encode_atoms(Format, Atoms)}; "Atom" -> {Id, encode_atoms(Format, Atoms)}; _ -> C end || {Id, _} = C <- Chunks]).

chunk(Chunks) ->
    case lists:keyfind("AtU8", 1, Chunks) of
        {_, D} -> D;
        false -> {_, D} = lists:keyfind("Atom", 1, Chunks), D
    end.

index_of(_, [], _) -> 0;
index_of(X, [X | _], N) -> N;
index_of(X, [_ | T], N) -> index_of(X, T, N + 1).

%% The atom table: a count, then each atom's length and bytes. A negative count means
%% the lengths use BEAM's compact encoding (OTP 28 and later).
decode_atoms(<<Count:32/signed, Rest/binary>>) when Count >= 0 -> {plain, plain_atoms(Count, Rest)};
decode_atoms(<<Count:32/signed, Rest/binary>>) -> {compact, compact_atoms(-Count, Rest)}.

plain_atoms(0, _) -> [];
plain_atoms(N, <<Len:8, Name:Len/binary, Rest/binary>>) -> [Name | plain_atoms(N - 1, Rest)].

compact_atoms(0, _) -> [];
compact_atoms(N, Bin) ->
    {Len, Rest} = compact_len(Bin),
    <<Name:Len/binary, Rest2/binary>> = Rest,
    [Name | compact_atoms(N - 1, Rest2)].

compact_len(<<B, Rest/binary>>) when B band 2#1000 =:= 0 -> {B bsr 4, Rest};
compact_len(<<B, B2, Rest/binary>>) when B band 2#10000 =:= 0 -> {((B band 2#11100000) bsl 3) bor B2, Rest}.

encode_atoms(plain, Atoms) -> iolist_to_binary([<<(length(Atoms)):32/signed>> | [[byte_size(A), A] || A <- Atoms]]);
encode_atoms(compact, Atoms) -> iolist_to_binary([<<(-length(Atoms)):32/signed>> | [[encode_len(byte_size(A)), A] || A <- Atoms]]).

encode_len(N) when N < 16 -> <<(N bsl 4)>>;
encode_len(N) when N < 2048 -> <<((((N bsr 3) band 2#11100000) bor 2#1000)), (N band 16#ff)>>.

%% ---- deciding and rewriting ----

rewrite(Kind, Args) ->
    try do_rewrite(Kind, Args)
    catch _:_ -> Args % anything unusual goes out as it was
    end.

%% Finch: the first argument is a %Finch.Request{}.
do_rewrite(finch, [Req | Rest]) ->
    #{scheme := Scheme, host := Host, port := Port, headers := Headers} = Req,
    Query = maps:get(query, Req, nil),
    case decide(atom_to_binary(Scheme, utf8), Host, Port, Query, Headers, []) of
        none -> [Req | Rest];
        {TScheme, THost, TPort, From} ->
            [Req#{scheme := binary_to_atom(TScheme, utf8), host := THost, port := TPort,
                  headers := [{?HOOK_HEADER, From}, {?WHO_HEADER, who()} | drop_host(Headers)]} | Rest]
    end;
%% hackney: request(Method, URL, Headers[, Body[, Options]]).
do_rewrite(hackney, [Method, Url, Headers | More]) when is_binary(Url); is_list(Url) ->
    Options = case More of [_, O] -> O; _ -> [] end,
    Extra = case proplists:get_value(basic_auth, Options) of {_, P} -> [P]; _ -> [] end,
    case decide_url(Url, Headers, Extra) of
        none -> [Method, Url, Headers | More];
        {NewUrl, From} -> [Method, NewUrl, [{?HOOK_HEADER, From}, {?WHO_HEADER, who()} | drop_host(Headers)] | More]
    end;
%% httpc: request(Method, {URL, Headers[, ContentType, Body]}, HttpOptions, Options[, Profile]).
do_rewrite(httpc, [Method, Request | More]) when is_tuple(Request) ->
    [Url, Headers | Tail] = tuple_to_list(Request),
    case decide_url(Url, Headers, []) of
        none -> [Method, Request | More];
        {NewUrl, From} ->
            Notes = case is_list(Url) of
                true -> [{"x-vallkey-host", binary_to_list(From)}, {"x-vallkey-hook", binary_to_list(who())}];
                false -> [{?HOOK_HEADER, From}, {?WHO_HEADER, who()}]
            end,
            [Method, list_to_tuple([NewUrl, Notes ++ drop_host(Headers) | Tail]) | More]
    end;
do_rewrite(_, Args) -> Args.

decide_url(Url, Headers, Extra) ->
    U = uri_string:parse(Url),
    Scheme = to_bin(maps:get(scheme, U, "")),
    Host = to_bin(maps:get(host, U, "")),
    case decide(Scheme, Host, maps:get(port, U, undefined), maps:get(query, U, nil), Headers, Extra) of
        none -> none;
        {TScheme, THost, TPort, From} ->
            New = U#{scheme => same_type(Url, TScheme), host => same_type(Url, THost), port => TPort},
            {uri_string:recompose(New), From}
    end.

%% {Scheme, Host, Port, the address it was for} on Vallkey, or none.
decide(Scheme0, Host, Port0, Query, Headers, Extra) ->
    Scheme = string:lowercase(Scheme0),
    Default = default_port(Scheme),
    Port = case Port0 of P when is_integer(P) -> P; _ -> Default end,
    {TScheme, THost, TPort} = target(),
    case (Scheme =:= <<"https">> orelse Scheme =:= <<"http">>)
         andalso not (string:lowercase(to_bin(Host)) =:= THost andalso Port =:= TPort)
         andalso ghost(Query, Headers, Extra) of
        false -> none;
        true ->
            From = case Port =:= Default of true -> to_bin(Host); false -> <<(to_bin(Host))/binary, ":", (integer_to_binary(Port))/binary>> end,
            debug("~s://~s -> ~s://~s", [Scheme, From, TScheme, THost]),
            {TScheme, THost, TPort, From}
    end.

ghost(Query, Headers, Extra) ->
    InQuery = case Query of
        nil -> false;
        undefined -> false;
        Q -> found(uri_string:percent_decode(to_bin(Q)))
    end,
    InQuery orelse lists:any(fun({_, V}) -> in_value(to_bin(V)); (_) -> false end, Headers)
        orelse lists:any(fun(V) -> found(to_bin(V)) end, Extra).

%% A ghost key in a header value, including inside Basic credentials.
in_value(V) ->
    found(V) orelse case re:run(V, "^\\s*basic\\s+([A-Za-z0-9+/=]+)\\s*$", [caseless, {capture, all_but_first, binary}]) of
        {match, [B64]} -> try found(base64:decode(B64)) catch _:_ -> false end;
        nomatch -> false
    end.

found(Bin) when is_binary(Bin) -> re:run(Bin, ?GHOST, [{capture, none}]) =:= match;
found(_) -> false.

drop_host(Headers) -> [H || {K, _} = H <- Headers, not lists:member(string:lowercase(to_bin(K)), [<<"host">>, ?HOOK_HEADER, ?WHO_HEADER])].

target() ->
    Raw = case os:getenv("VALLKEY_API") of false -> "https://api.vallkey.com"; "" -> "https://api.vallkey.com"; V -> V end,
    U = uri_string:parse(Raw),
    Scheme = string:lowercase(to_bin(maps:get(scheme, U, "https"))),
    {Scheme, string:lowercase(to_bin(maps:get(host, U, "api.vallkey.com"))), maps:get(port, U, default_port(Scheme))}.

default_port(<<"https">>) -> 443;
default_port(_) -> 80.

to_bin(B) when is_binary(B) -> B;
to_bin(L) when is_list(L) -> unicode:characters_to_binary(L);
to_bin(A) when is_atom(A) -> atom_to_binary(A, utf8);
to_bin(I) when is_integer(I) -> integer_to_binary(I).

same_type(Like, Bin) when is_list(Like) -> binary_to_list(Bin);
same_type(_, Bin) -> Bin.

debug(Format, Args) ->
    case os:getenv("VALLKEY_DEBUG") of
        "1" -> io:format(standard_error, "[vallkey] " ++ Format ++ "~n", Args);
        _ -> ok
    end.
