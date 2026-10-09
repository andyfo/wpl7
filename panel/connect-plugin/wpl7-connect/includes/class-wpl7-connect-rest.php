<?php
defined('ABSPATH') || exit;

/**
 * The REST bridge (docs/internal/connect-protocol.md, rest): one request to the site's own REST
 * API, run in this process through rest_do_request(), as a user the panel names or as no one.
 * Nothing goes over the network, so no application password is needed, and the answer is what
 * WordPress's REST server would have printed.
 */
final class WPL7_Connect_Rest
{
    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    const MAX_ROUTE = 2000;
    const MAX_QUERY = 65536;
    /** The body the panel gets back; longer is cut, and says so. */
    const MAX_BODY = 1048576;
    /** The response headers that travel back, lower-case. */
    const HEADERS = ['content-type', 'x-wp-total', 'x-wp-totalpages', 'link', 'allow'];

    /** The `rest` action: { method, route, query?, body?, user? }. */
    public static function action($params)
    {
        $method = isset($params['method']) ? $params['method'] : null;
        if (!in_array($method, self::METHODS, true)) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'method']);
        }
        $route = isset($params['route']) ? $params['route'] : null;
        // Not this plugin's own routes: they answer the panel directly and end the request, which
        // would cut this one short.
        if (!is_string($route) || $route === '' || $route[0] !== '/' || strlen($route) > self::MAX_ROUTE
            || preg_match('/[\x00-\x1f\x7f?#]/', $route)
            || stripos(rtrim($route, '/') . '/', '/' . WPL7_Connect_Server::REST_NAMESPACE . '/') === 0) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'route']);
        }
        $query = [];
        if (array_key_exists('query', $params) && $params['query'] !== null) {
            if (!is_string($params['query']) || strlen($params['query']) > self::MAX_QUERY) {
                throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'query']);
            }
            wp_parse_str(ltrim($params['query'], '?'), $query);
        }
        $user = 0;
        if (array_key_exists('user', $params) && $params['user'] !== null) {
            $found = is_string($params['user']) || is_int($params['user']) ? self::find_user((string) $params['user']) : false;
            if (!$found) {
                throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'user']);
            }
            $user = (int) $found->ID;
        }

        $request = new WP_REST_Request($method, $route);
        $request->set_query_params($query);
        if (array_key_exists('body', $params)) {
            $request->set_header('Content-Type', 'application/json');
            $request->set_body((string) wp_json_encode($params['body']));
        }
        // Only now, inside a request the panel signed and after every check, does anyone sign in.
        wp_set_current_user($user);
        $server = rest_get_server();
        $response = rest_do_request($request);
        // As WP_REST_Server::serve_request() goes on from its dispatch.
        $response = rest_ensure_response($response);
        if (is_wp_error($response)) {
            $response = self::error_to_response($response);
        }
        $response = apply_filters('rest_post_dispatch', rest_ensure_response($response), $server, $request);
        $status = (int) $response->get_status();
        $embed = false;
        if (isset($query['_embed'])) {
            $embed = function_exists('rest_parse_embed_param') ? rest_parse_embed_param($query['_embed']) : true;
        }
        $data = $server->response_to_data($response, $embed);
        $data = apply_filters('rest_pre_echo_response', $data, $server, $request);
        $body = '';
        if ($status !== 204 && $data !== null) {
            $options = array_key_exists('_pretty', $query) ? JSON_PRETTY_PRINT : 0;
            $options = (int) apply_filters('rest_json_encode_options', $options, $request);
            $encoded = wp_json_encode($data, $options);
            $body = is_string($encoded) ? $encoded : (string) json_encode($data, $options | JSON_PARTIAL_OUTPUT_ON_ERROR);
        }
        $truncated = strlen($body) > self::MAX_BODY;
        return [
            'status' => $status,
            'headers' => self::headers($response->get_headers()),
            // wp_json_encode() escapes every character past ASCII, so the cut cannot split one;
            // a body a filter encoded otherwise is cut on a character all the same.
            'body' => $truncated ? WPL7_Connect_Plugin::cut_bytes($body, self::MAX_BODY) : WPL7_Connect_Plugin::utf8_display($body),
            'truncated' => $truncated,
        ];
    }

    /** The headers that travel back, lower-case; the content type the REST server would send by default. */
    private static function headers($headers)
    {
        $out = ['content-type' => 'application/json; charset=' . get_option('blog_charset')];
        foreach ((array) $headers as $name => $value) {
            $name = strtolower((string) $name);
            if (in_array($name, self::HEADERS, true) && (is_string($value) || is_int($value))) {
                $out[$name] = WPL7_Connect_Plugin::cut((string) $value, 8192);
            }
        }
        return $out;
    }

    /** WP_REST_Server::error_to_response(), which is not public before WordPress 5.7's helper. */
    private static function error_to_response($error)
    {
        if (function_exists('rest_convert_error_to_response')) {
            return rest_convert_error_to_response($error);
        }
        $data = $error->get_error_data();
        $status = is_array($data) && isset($data['status']) ? (int) $data['status'] : 500;
        $errors = [];
        foreach ((array) $error->errors as $code => $messages) {
            foreach ((array) $messages as $message) {
                $errors[] = ['code' => $code, 'message' => $message, 'data' => $error->get_error_data($code)];
            }
        }
        $first = $errors ? $errors[0] : ['code' => 'rest_error', 'message' => '', 'data' => null];
        if (count($errors) > 1) {
            array_shift($errors);
            $first['additional_errors'] = $errors;
        }
        return new WP_REST_Response($first, $status);
    }

    /**
     * A user by id, email or login, as WP-CLI's --user takes one: a number is an id, an email is
     * looked up as an email and then as a login, anything else as a login. False when none is.
     */
    public static function find_user($value)
    {
        $value = trim((string) $value);
        if ($value === '') {
            return false;
        }
        if (is_numeric($value)) {
            return get_user_by('id', (int) $value);
        }
        if (is_email($value)) {
            $user = get_user_by('email', $value);
            return $user ? $user : get_user_by('login', $value);
        }
        return get_user_by('login', $value);
    }
}
