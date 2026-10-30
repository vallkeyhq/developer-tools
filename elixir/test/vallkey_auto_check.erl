%% erlc test/vallkey_auto_check.erl && GITLAB_CI=true VALLKEY_ENV=ci erl -noshell -pa . -s vallkey_auto_check run
%% Checks the hook with httpc (no other libraries needed) against two local servers,
%% "vallkey" and "provider", which say who answered. Halts with 1 if anything is wrong.
%% This fixture checks httpc; Finch and hackney require additional integration tests.
-module(vallkey_auto_check).
-export([run/0]).

ghost() -> lists:flatten(lists:join("_", ["gk", "openai", "A1b2C3d4E5f6G7h8I9j0Kl", "M1n2O3p4Q5r6S7t8U9v0Wx1Y2z3A4b5C6d7E8f9G0hI"])).

serve(Name, Parent) ->
    {ok, L} = gen_tcp:listen(0, [binary, {active, false}, {reuseaddr, true}, {ip, {127, 0, 0, 1}}, {packet, http_bin}]),
    {ok, Port} = inet:port(L),
    spawn(fun() -> accept(L, Name, Parent) end),
    Port.

accept(L, Name, Parent) ->
    {ok, S} = gen_tcp:accept(L),
    spawn(fun() -> accept(L, Name, Parent) end),
    {ok, {http_request, Method, {abs_path, Path}, _}} = gen_tcp:recv(S, 0),
    Headers = headers(S, []),
    Parent ! {seen, Name, Method, Path, Headers},
    Body = list_to_binary(Name),
    inet:setopts(S, [{packet, raw}]),
    gen_tcp:send(S, [<<"HTTP/1.1 200 OK\r\ncontent-length: ">>, integer_to_binary(byte_size(Body)), <<"\r\nconnection: close\r\n\r\n">>, Body]),
    gen_tcp:close(S).

headers(S, Acc) ->
    case gen_tcp:recv(S, 0) of
        {ok, {http_header, _, K, _, V}} -> headers(S, [{string:lowercase(to_bin(K)), V} | Acc]);
        {ok, http_eoh} -> Acc
    end.

to_bin(A) when is_atom(A) -> atom_to_binary(A, utf8);
to_bin(B) -> B.

check(What, true) -> io:format("ok   ~s~n", [What]), 0;
check(What, _) -> io:format("FAIL ~s~n", [What]), 1.

get(Url, Headers) ->
    {ok, {_, _, Body}} = httpc:request(get, {Url, Headers}, [], []),
    Body.

last() -> receive {seen, N, M, P, H} -> {N, M, P, H} after 2000 -> none end.

run() ->
    application:ensure_all_started(inets),
    VPort = serve("vallkey", self()),
    PPort = serve("provider", self()),
    os:putenv("VALLKEY_API", "http://127.0.0.1:" ++ integer_to_list(VPort)),
    httpc:module_info(), % loaded before the hook starts, as in a release
    ok = vallkey_auto:start(),
    G = ghost(),
    F1 = check("a ghost key in Authorization goes to Vallkey", get("http://api.openai.com/v1/models?limit=2", [{"authorization", "Bearer " ++ G}]) =:= "vallkey"),
    {_, _, Path, H} = last(),
    F2 = check("path, query and the address it was for are kept", Path =:= <<"/v1/models?limit=2">> andalso proplists:get_value(<<"x-vallkey-host">>, H) =:= <<"api.openai.com">>
        andalso proplists:get_value(<<"host">>, H) =:= iolist_to_binary(["127.0.0.1:", integer_to_list(VPort)])),
    F9 = check("it says what sent the request", proplists:get_value(<<"x-vallkey-hook">>, H) =:= iolist_to_binary(["erlang/0.1.0; runtime=", erlang:system_info(otp_release), "; platform=gitlab-ci; env=ci"])),
    F3 = check("a request without a ghost key is left alone", get("http://127.0.0.1:" ++ integer_to_list(PPort) ++ "/plain", [{"authorization", "Bearer sk-real"}]) =:= "provider"),
    last(),
    F4 = check("a ghost key in Basic credentials goes to Vallkey", get("http://api.twilio.com/2010-04-01/Accounts.json", [{"authorization", "Basic " ++ base64:encode_to_string("AC1:" ++ G)}]) =:= "vallkey"),
    last(),
    F5 = check("a ghost key in the query goes to Vallkey", get("http://generativelanguage.googleapis.com/v1beta/models?key=" ++ G, []) =:= "vallkey"),
    last(),
    {ok, {_, _, Posted}} = httpc:request(post, {"http://api.stripe.com/v1/customers", [{"authorization", "Bearer " ++ G}], "application/x-www-form-urlencoded", "email=a"}, [], []),
    F6 = check("a POST goes to Vallkey", Posted =:= "vallkey"),
    last(),
    F7 = check("other functions of the module still work", is_list(httpc:info())),
    F8 = check("undefined functions still fail as before", try httpc:no_such_function(), false catch error:undef -> true end),
    halt(F1 + F2 + F3 + F4 + F5 + F6 + F7 + F8 + F9).
